import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const DB_CONTEUDO   = '917ec2ebdb2b4c0cb1f9f9d523680a04'
const NOTION_VERSION = '2022-06-28'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

async function notionQuery(token: string, dbId: string, body: unknown = {}) {
  let all: any[] = []
  let cursor: string | undefined
  do {
    const payload: any = { page_size: 100, ...body as object }
    if (cursor) payload.start_cursor = cursor
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`Notion ${res.status}: ${(err as any).message || res.statusText}`)
    }
    const result = await res.json()
    all = all.concat(result.results ?? [])
    cursor = result.has_more ? result.next_cursor : undefined
  } while (cursor)
  return all
}

function num(page: any, prop: string): number {
  return page.properties?.[prop]?.number ?? 0
}

function dateStr(page: any, prop: string): string {
  return page.properties?.[prop]?.date?.start ?? ''
}

function titleStr(page: any, prop: string): string {
  const t = page.properties?.[prop]?.title
  return Array.isArray(t) ? t.map((b: any) => b.plain_text).join('').trim() : ''
}

function selectStr(page: any, prop: string): string {
  return page.properties?.[prop]?.select?.name ?? ''
}

function statusStr(page: any, prop: string): string {
  return page.properties?.[prop]?.status?.name ?? ''
}

function avg(arr: number[]): number {
  if (!arr.length) return 0
  return Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 10) / 10
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const { mes } = await req.json().catch(() => ({}))
    const mesFiltro = mes || new Date().toISOString().slice(0, 7)
    const [yr, mo] = mesFiltro.split('-').map(Number)
    const iniMo  = `${mesFiltro}-01`
    const proxMo = mo === 12 ? `${yr + 1}-01-01` : `${yr}-${String(mo + 1).padStart(2, '0')}-01`

    const { data: cfg } = await sb
      .from('app_config')
      .select('valor')
      .eq('chave', 'notion_token')
      .maybeSingle()

    if (!cfg?.valor) return json({ setup: true })
    const token = cfg.valor

    // Filtra posts publicados no mês
    const filterBody = {
      filter: {
        and: [
          { property: 'Data de Publicação', date: { on_or_after: iniMo } },
          { property: 'Data de Publicação', date: { before: proxMo } },
        ],
      },
      sorts: [{ property: 'Data de Publicação', direction: 'descending' }],
    }

    const pages = await notionQuery(token, DB_CONTEUDO, filterBody)

    // Publicados = status Concluído
    const publicados = pages.filter((p: any) => {
      const s = statusStr(p, 'Status')
      return s === 'Concluído'
    })

    let totalViz = 0, totalAlcance = 0, totalCompart = 0
    let totalComent = 0, totalSalv = 0, totalSeguidores = 0
    const ret3s: number[] = [], tempoViz: number[] = []
    const porFunil: Record<string, number> = {}
    const porResultado: Record<string, number> = {}
    const porFormato: Record<string, number> = {}
    let melhorPost: any = null
    let melhorViz = -1

    for (const p of publicados) {
      const viz    = num(p, 'Visualizações')
      const alc    = num(p, 'Alcance')
      const comp   = num(p, 'Compartilhamentos')
      const coment = num(p, 'Comentários')
      const salv   = num(p, 'Salvamentos')
      const seg    = num(p, 'Seguidores Ganhos')
      const ret    = num(p, 'Retenção 3s (%)')
      const tempo  = num(p, 'Tempo Médio de Visualização (%)')
      const funil  = selectStr(p, 'Funil')
      const result = selectStr(p, 'Resultado')
      const format = selectStr(p, 'Formato')
      const titulo = titleStr(p, 'Tema/Título')
      const data   = dateStr(p, 'Data de Publicação')

      totalViz       += viz
      totalAlcance   += alc
      totalCompart   += comp
      totalComent    += coment
      totalSalv      += salv
      totalSeguidores += seg
      if (ret  > 0) ret3s.push(ret)
      if (tempo > 0) tempoViz.push(tempo)
      if (funil)  porFunil[funil]   = (porFunil[funil]   || 0) + 1
      if (result) porResultado[result] = (porResultado[result] || 0) + 1
      if (format) porFormato[format]   = (porFormato[format]   || 0) + 1

      if (viz > melhorViz) {
        melhorViz = viz
        melhorPost = { titulo, visualizacoes: viz, alcance: alc, funil, resultado: result, data }
      }
    }

    // Histórico últimos 3 meses (apenas total de posts e visualizações)
    const allPages = await notionQuery(token, DB_CONTEUDO, {
      filter: { property: 'Status', status: { equals: 'Concluído' } },
      sorts: [{ property: 'Data de Publicação', direction: 'ascending' }],
    })
    const histMap: Record<string, { posts: number; viz: number }> = {}
    for (const p of allPages) {
      const d = dateStr(p, 'Data de Publicação')
      if (!d) continue
      const k = d.slice(0, 7)
      if (!histMap[k]) histMap[k] = { posts: 0, viz: 0 }
      histMap[k].posts++
      histMap[k].viz += num(p, 'Visualizações')
    }
    const historico = Object.entries(histMap)
      .map(([mes, v]) => ({ mes, ...v }))
      .sort((a, b) => a.mes.localeCompare(b.mes))
      .slice(-4)

    return json({
      mes: mesFiltro,
      totalPublicados: publicados.length,
      totalViz,
      totalAlcance,
      totalCompart,
      totalComent,
      totalSalv,
      totalSeguidores,
      avgRetencao3s: avg(ret3s),
      avgTempoViz:   avg(tempoViz),
      porFunil,
      porResultado,
      porFormato,
      melhorPost,
      historico,
      semDados: publicados.length === 0,
    })
  } catch (e: any) {
    console.error('notion-conteudo error:', e)
    return json({ error: e.message }, 500)
  }
})
