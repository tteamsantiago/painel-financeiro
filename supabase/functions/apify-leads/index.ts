import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// Chama actor Apify no modo síncrono (bloqueia até terminar, max ~90s)
async function apifyRun(token: string, actorId: string, input: unknown, timeoutSecs = 90): Promise<any[]> {
  const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=${timeoutSecs}&memory=256`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Actor ${actorId} → ${res.status}: ${text.slice(0, 300)}`)
  }
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

// Busca detalhes de perfis em batch (máx 50 por vez)
async function fetchProfiles(token: string, usernames: string[]): Promise<any[]> {
  if (!usernames.length) return []
  const batch = usernames.slice(0, 50)
  return apifyRun(token, 'apify~instagram-profile-scraper', {
    usernames: batch,
    resultsType: 'details',
    proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  }, 60)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const body = await req.json().catch(() => ({}))
    const {
      plataforma = 'instagram',
      tipo,
      busca,
      limite = 20,
      min_seguidores = 0,
      max_seguidores = 0,
      palavras_bio = '',
      genero = 'todos',
    } = body

    const { data: cfg } = await sb
      .from('app_config')
      .select('valor')
      .eq('chave', 'apify_token')
      .maybeSingle()

    if (!cfg?.valor) return json({ setup: true })
    if (tipo === 'check') return json({ ok: true })

    const token = cfg.valor
    const debug: string[] = []
    let rawItems: any[] = []

    // ── INSTAGRAM ──────────────────────────────────────────────
    if (plataforma === 'instagram') {

      if (tipo === 'perfil') {
        // Tenta buscar seguidores do perfil
        debug.push(`Buscando seguidores de @${busca}...`)
        try {
          rawItems = await apifyRun(token, 'apify~instagram-profile-scraper', {
            usernames: [busca],
            resultsType: 'followers',
            resultsLimit: Math.min(limite * 3, 300),
            proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
          })
          debug.push(`${rawItems.length} seguidores encontrados`)
        } catch (e: any) {
          debug.push(`Followers falhou (${e.message.slice(0,80)}), tentando posts + comentadores...`)
          // Fallback: pega posts recentes e extrai comentadores
          const posts = await apifyRun(token, 'apify~instagram-profile-scraper', {
            usernames: [busca],
            resultsType: 'posts',
            resultsLimit: 5,
            proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
          })
          debug.push(`${posts.length} posts encontrados`)
          if (posts.length > 0) {
            const postUrls = posts.map((p: any) => p.url || p.shortCode ? `https://www.instagram.com/p/${p.shortCode}/` : '').filter(Boolean)
            if (postUrls.length > 0) {
              const comments = await apifyRun(token, 'apify~instagram-comment-scraper', {
                directUrls: postUrls.slice(0, 3),
                resultsLimit: Math.min(limite * 5, 200),
                proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
              })
              debug.push(`${comments.length} comentários encontrados`)
              const usernames = [...new Set(
                comments.map((c: any) => c.ownerUsername || c.username).filter(Boolean)
              )].slice(0, 50) as string[]
              debug.push(`${usernames.length} comentadores únicos — carregando perfis...`)
              rawItems = await fetchProfiles(token, usernames)
              debug.push(`${rawItems.length} perfis carregados`)
            }
          }
        }

      } else if (tipo === 'hashtag') {
        // Max 2 chamadas Apify: posts -> comentadores (sem fetchProfiles para evitar timeout)
        debug.push(`Buscando posts com #${busca}...`)
        const posts = await apifyRun(token, 'apify~instagram-scraper', {
          directUrls: [`https://www.instagram.com/explore/tags/${encodeURIComponent(busca)}/`],
          resultsType: 'posts',
          resultsLimit: Math.min(limite * 2, 40),
          proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
        }, 60)
        debug.push(`${posts.length} posts encontrados`)

        const autores = [...new Set(
          posts.map((p: any) =>
            p.ownerUsername || p.owner?.username || p.username || p.author?.username
          ).filter(Boolean)
        )] as string[]

        if (autores.length > 0) {
          debug.push(`${autores.length} autores com username — mapeando leads`)
          rawItems = posts
            .filter((p: any) => p.ownerUsername || p.owner?.username || p.username)
            .map((p: any) => ({
              username: p.ownerUsername || p.owner?.username || p.username,
              fullName: p.ownerFullName || '',
              biography: '',
              followersCount: 0,
              postsCount: 0,
              profilePicUrl: '',
              url: `https://www.instagram.com/${p.ownerUsername || p.owner?.username || p.username}/`,
            }))
        } else {
          const postUrls = posts.map((p: any) =>
            p.url || (p.shortCode ? `https://www.instagram.com/p/${p.shortCode}/` : '')
          ).filter(Boolean).slice(0, 3)

          if (postUrls.length === 0) {
            debug.push(`Sem URLs de posts disponiveis`)
          } else {
            debug.push(`Buscando comentarios de ${postUrls.length} posts...`)
            const comments = await apifyRun(token, 'apify~instagram-comment-scraper', {
              directUrls: postUrls,
              resultsLimit: Math.min(limite * 5, 200),
              proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
            }, 70)
            debug.push(`${comments.length} comentarios encontrados`)

            const commenters = [...new Set(
              comments.map((c: any) => c.ownerUsername || c.username || c.owner?.username).filter(Boolean)
            )].slice(0, limite) as string[]

            debug.push(`${commenters.length} comentadores unicos — retornando como leads`)
            rawItems = commenters.map((u: string) => ({
              username: u,
              fullName: '',
              biography: '',
              followersCount: 0,
              postsCount: 0,
              profilePicUrl: '',
              url: `https://www.instagram.com/${u}/`,
            }))
          }
        }

      } else if (tipo === 'post-comentadores') {
        // Busca comentadores de um post/reel
        debug.push(`Buscando comentadores do post...`)
        const comments = await apifyRun(token, 'apify~instagram-comment-scraper', {
          directUrls: [busca],
          resultsLimit: Math.min(limite * 5, 300),
          proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
        })
        debug.push(`${comments.length} comentários encontrados`)

        const usernames = [...new Set(
          comments.map((c: any) => c.ownerUsername || c.username || c.owner?.username).filter(Boolean)
        )].slice(0, 50) as string[]

        debug.push(`${usernames.length} comentadores únicos — carregando perfis...`)
        rawItems = await fetchProfiles(token, usernames)
        debug.push(`${rawItems.length} perfis carregados`)
      }

    // ── TIKTOK ─────────────────────────────────────────────────
    } else if (plataforma === 'tiktok') {

      if (tipo === 'perfil') {
        debug.push(`Buscando vídeos de @${busca}...`)
        rawItems = await apifyRun(token, 'clockworks~free-tiktok-scraper', {
          profiles: [busca],
          resultsPerPage: Math.min(limite, 50),
          shouldDownloadVideos: false,
          shouldDownloadCovers: false,
        })
        debug.push(`${rawItems.length} vídeos encontrados`)

      } else if (tipo === 'hashtag') {
        debug.push(`Buscando vídeos com #${busca}...`)
        rawItems = await apifyRun(token, 'clockworks~free-tiktok-scraper', {
          hashtags: [busca],
          resultsPerPage: Math.min(limite, 50),
          shouldDownloadVideos: false,
          shouldDownloadCovers: false,
        })
        debug.push(`${rawItems.length} vídeos encontrados`)

      } else if (tipo === 'post-comentadores') {
        debug.push(`Buscando comentários do vídeo...`)
        rawItems = await apifyRun(token, 'clockworks~free-tiktok-scraper', {
          postURLs: [busca],
          shouldDownloadComments: true,
          maxComments: Math.min(limite * 3, 200),
          shouldDownloadVideos: false,
          shouldDownloadCovers: false,
        })
        debug.push(`${rawItems.length} comentários encontrados`)
      }
    }

    // ── FILTROS ─────────────────────────────────────────────────
    let items = rawItems

    if (min_seguidores > 0) {
      items = items.filter((i: any) => (i.followersCount || i.followers || 0) >= min_seguidores)
      debug.push(`Após filtro min_seguidores(${min_seguidores}): ${items.length}`)
    }
    if (max_seguidores > 0) {
      items = items.filter((i: any) => (i.followersCount || i.followers || 0) <= max_seguidores)
      debug.push(`Após filtro max_seguidores(${max_seguidores}): ${items.length}`)
    }
    if (palavras_bio) {
      const words = palavras_bio.toLowerCase().split(',').map((w: string) => w.trim()).filter(Boolean)
      items = items.filter((i: any) => {
        const bio = (i.biography || i.bio || '').toLowerCase()
        return words.some((w: string) => bio.includes(w))
      })
      debug.push(`Após filtro palavras_bio("${palavras_bio}"): ${items.length}`)
    }
    if (genero !== 'todos') {
      const masc = ['pai', 'homem', ' ele', 'he/', '/him', '👨', 'masculin', 'senhor', 'meu pai']
      const fem  = ['mãe', 'mae', 'mulher', ' ela', 'she/', '/her', '👩', 'feminin', 'minha mae', 'menina']
      items = items.filter((i: any) => {
        const bio = (i.biography || i.bio || '').toLowerCase()
        if (genero === 'mulher') return fem.some(w => bio.includes(w))
        if (genero === 'homem')  return masc.some(w => bio.includes(w))
        return true
      })
      debug.push(`Após filtro genero(${genero}): ${items.length}`)
    }

    items = items.slice(0, limite)

    const msg = items.length === 0
      ? `Nenhum resultado. ${debug.join(' → ')}`
      : undefined

    return json({ items, debug, total: items.length, message: msg })

  } catch (e: any) {
    console.error('apify-leads error:', e)
    return json({ error: e.message, debug: [e.message] }, 200)
  }
})
