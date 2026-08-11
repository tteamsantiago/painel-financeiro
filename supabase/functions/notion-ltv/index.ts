import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const DB_RELACIONAMENTO = '2e13324523a980358006e2a0552e02ca'
const DB_CAC            = '2e13324523a980b5a0dcee9b68ce1e1b'
const NOTION_VERSION    = '2022-06-28'

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

function monthsDiff(start: string, end: string): number {
  if (!start || !end) return 0
  const s = new Date(start)
  const e = new Date(end)
  const months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth())
  const days   = e.getDate() - s.getDate()
  return Math.max(0, months + days / 30)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Token Notion
    const { data: cfg } = await sb
      .from('app_config')
      .select('valor')
      .eq('chave', 'notion_token')
      .maybeSingle()

    if (!cfg?.valor) return json({ setup: true })
    const token = cfg.valor
    const today = new Date().toISOString().slice(0, 10)

    // Busca todos os alunos do Controle de Relacionamento
    const pages = await notionQuery(token, DB_RELACIONAMENTO, {})

    const students = pages.map((p: any) => {
      const entrada = dateStr(p, 'Data de Entrada')
      const saida   = dateStr(p, 'Data de Saída ')   // propriedade tem espaço no final
      const status  = selectStr(p, 'Status')
      const plano   = selectStr(p, 'Plano')
      const ticket  = num(p, 'Ticket Mensal Médio')
      const motivo  = selectStr(p, 'Motivo da Saída ') // idem
      const nome    = titleStr(p, 'Nome do Cliente')

      const endDate = saida || today
      const meses   = monthsDiff(entrada, endDate)
      const ltv     = ticket * meses

      return { nome, plano, status, entrada, saida, ticket, motivo, meses, ltv }
    })

    // Apenas alunos com ticket > 0
    const comTicket = students.filter((s: any) => s.ticket > 0)
    const n         = comTicket.length

    const ltvMedio      = n > 0 ? Math.round(comTicket.reduce((s: number, x: any) => s + x.ltv,    0) / n) : 0
    const ticketMedio   = n > 0 ? Math.round(comTicket.reduce((s: number, x: any) => s + x.ticket, 0) / n) : 0
    const retencaoMedia = n > 0 ? Math.round((comTicket.reduce((s: number, x: any) => s + x.meses, 0) / n) * 10) / 10 : 0

    // Churn por motivo (apenas inativos)
    const churnMap: Record<string, number> = {}
    for (const s of students.filter((s: any) => s.status === 'Inativo' && s.motivo)) {
      churnMap[s.motivo] = (churnMap[s.motivo] || 0) + 1
    }
    const churn = Object.entries(churnMap)
      .map(([motivo, count]) => ({ motivo, count }))
      .sort((a, b) => b.count - a.count)

    // Agrupamento por plano
    const planMap: Record<string, { count: number; ticket: number; meses: number; ltv: number }> = {}
    for (const s of comTicket) {
      const k = (s as any).plano || 'Sem plano'
      if (!planMap[k]) planMap[k] = { count: 0, ticket: 0, meses: 0, ltv: 0 }
      planMap[k].count++
      planMap[k].ticket += (s as any).ticket
      planMap[k].meses  += (s as any).meses
      planMap[k].ltv    += (s as any).ltv
    }
    const porPlano = Object.entries(planMap).map(([plano, v]) => ({
      plano,
      count: v.count,
      ticketMedio:   Math.round(v.ticket / v.count),
      retencaoMedia: Math.round((v.meses  / v.count) * 10) / 10,
      ltvMedio:      Math.round(v.ltv    / v.count),
    }))

    // CAC médio histórico (banco CAC do Notion)
    const cacPages = await notionQuery(token, DB_CAC, {})
    let cacTotal = 0, cacCount = 0
    for (const p of cacPages) {
      const gasto    = num(p, 'Gasto com Tráfego')
      const fechados = num(p, 'Leads Fechados')
      if (gasto > 0 && fechados > 0) {
        cacTotal += gasto / fechados
        cacCount++
      }
    }
    const cacMedio = cacCount > 0 ? Math.round(cacTotal / cacCount) : null
    const ltvCacRatio = cacMedio && ltvMedio ? Math.round((ltvMedio / cacMedio) * 10) / 10 : null

    return json({
      ltvMedio,
      ticketMedio,
      retencaoMedia,
      cacMedio,
      ltvCacRatio,
      totalAlunos: students.length,
      churn,
      porPlano,
    })
  } catch (e: any) {
    console.error('notion-ltv error:', e)
    return json({ error: e.message }, 500)
  }
})
