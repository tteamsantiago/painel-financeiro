import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// IDs dos bancos de dados no Notion
const DB_LEADS = '2e13324523a980a5afd7e301e21349a5'
const DB_CAC   = '2e13324523a980b5a0dcee9b68ce1e1b'
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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // mes = "2026-08"
    const { mes } = await req.json().catch(() => ({}))
    const mesFiltro = mes || new Date().toISOString().slice(0, 7)
    const [yr, mo] = mesFiltro.split('-').map(Number)
    const proxMo   = mo === 12 ? `${yr + 1}-01-01` : `${yr}-${String(mo + 1).padStart(2, '0')}-01`
    const iniMo    = `${mesFiltro}-01`

    // Token Notion
    const { data: cfg } = await sb
      .from('app_config')
      .select('valor')
      .eq('chave', 'notion_token')
      .maybeSingle()

    if (!cfg?.valor) return json({ setup: true })
    const token = cfg.valor

    // Filtra entradas do mês pelo campo Data
    const filterBody = {
      filter: {
        and: [
          { property: 'Data', date: { on_or_after: iniMo } },
          { property: 'Data', date: { before: proxMo } },
        ],
      },
      sorts: [{ property: 'Data', direction: 'ascending' }],
    }

    const pages = await notionQuery(token, DB_LEADS, filterBody)

    // Soma conversões e calls; pega último snapshot para leads ativos/adormecidos
    let conversoesMes = 0
    let callsMes      = 0
    let renovacaoMes  = 0
    let leadsNegociacao = 0
    let leadsAdormecidos = 0
    let totalLeads = 0
    let lastData = ''

    for (const p of pages) {
      const d = dateStr(p, 'Data')
      conversoesMes    += num(p, 'Conversões')
      callsMes         += num(p, 'Call Agendada')
      renovacaoMes     += num(p, 'Taxa de Renovação')
      // Snapshot mais recente do mês (acumulado)
      if (!lastData || d > lastData) {
        lastData         = d
        leadsNegociacao  = num(p, 'Leads em Negociação')
        leadsAdormecidos = num(p, 'Leads Adormecidos')
        totalLeads       = num(p, 'Número de Leads')
      }
    }

    // CAC do mês (se disponível)
    const cacPages = await notionQuery(token, DB_CAC, {})
    const nomesMes = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                      'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']
    const nomeMes  = nomesMes[mo - 1]
    const cacEntry = cacPages.find((p: any) => {
      const t = titleStr(p, 'Mês').toLowerCase()
      return t.startsWith(nomeMes.toLowerCase().slice(0, 3))
    })
    const gastoTrafego  = cacEntry ? num(cacEntry, 'Gasto com Tráfego') : null
    const leadsFechados = cacEntry ? num(cacEntry, 'Leads Fechados') : null
    const cac = gastoTrafego && leadsFechados ? Math.round(gastoTrafego / leadsFechados) : null

    // Histórico: últimos 5 meses (snapshot final de cada mês)
    const allPages = await notionQuery(token, DB_LEADS, {
      sorts: [{ property: 'Data', direction: 'ascending' }],
    })

    const monthMap = new Map<string, any>()
    for (const p of allPages) {
      const d = dateStr(p, 'Data')
      if (!d) continue
      const key = d.slice(0, 7)
      const existing = monthMap.get(key)
      if (!existing || d > existing.data) {
        monthMap.set(key, {
          mes: key,
          data: d,
          leadsNegociacao: num(p, 'Leads em Negociação'),
          leadsAdormecidos: num(p, 'Leads Adormecidos'),
          totalLeads: num(p, 'Número de Leads'),
        })
      }
    }
    // Soma conversões por mês
    for (const p of allPages) {
      const d = dateStr(p, 'Data')
      if (!d) continue
      const key = d.slice(0, 7)
      const entry = monthMap.get(key)
      if (entry) {
        entry.conversoes    = (entry.conversoes    || 0) + num(p, 'Conversões')
        entry.callsAgendadas = (entry.callsAgendadas || 0) + num(p, 'Call Agendada')
      }
    }

    const historico = Array.from(monthMap.values())
      .sort((a, b) => a.mes.localeCompare(b.mes))
      .slice(-5)

    return json({
      mes: mesFiltro,
      leadsNegociacao,
      leadsAdormecidos,
      totalLeads,
      conversoesMes,
      callsMes,
      renovacaoMes,
      gastoTrafego,
      cac,
      historico,
      semDados: pages.length === 0,
    })
  } catch (e: any) {
    console.error('notion-crm error:', e)
    return json({ error: e.message }, 500)
  }
})
