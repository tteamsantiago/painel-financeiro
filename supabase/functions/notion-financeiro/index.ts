import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const DB_FINANCEIRO = '2e13324523a98030ade7dd4ea5a87624'
const NOTION_VERSION = '2022-06-28'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

async function notionQuery(token: string, dbId: string, body: unknown = {}) {
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Notion API ${res.status}: ${err.message || res.statusText}`)
  }
  return res.json()
}

function getProp(page: any, name: string): any {
  return page.properties?.[name]
}

function getNumber(page: any, name: string): number {
  return getProp(page, name)?.number ?? 0
}

function getTitle(page: any, name: string): string {
  const t = getProp(page, name)?.title
  return Array.isArray(t) ? t.map((b: any) => b.plain_text).join('') : ''
}

function getDate(page: any, name: string): string {
  return getProp(page, name)?.date?.start ?? ''
}

// Mês nome PT → número para ordenação
const MES_ORDER: Record<string, number> = {
  janeiro: 1, fevereiro: 2, março: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
}

function mesKey(mes: string, data: string): string {
  // Usar data ISO (YYYY-MM-DD) como chave de ordenação
  return data.substring(0, 7) // YYYY-MM
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { meses = 6 } = await req.json().catch(() => ({}))

    // Busca token do Notion
    const { data: cfg } = await sb
      .from('app_config')
      .select('valor')
      .eq('chave', 'notion_token')
      .maybeSingle()

    if (!cfg?.valor) {
      return json({ setup: true })
    }

    const token = cfg.valor

    // Consulta banco de dados Controle Financeiro com paginação
    let allPages: any[] = []
    let cursor: string | undefined = undefined

    do {
      const body: any = {
        sorts: [{ property: 'Data de Fechamento', direction: 'ascending' }],
        page_size: 100,
      }
      if (cursor) body.start_cursor = cursor

      const result = await notionQuery(token, DB_FINANCEIRO, body)
      allPages = allPages.concat(result.results ?? [])
      cursor = result.has_more ? result.next_cursor : undefined
    } while (cursor)

    // Agrupa por mês (chave = YYYY-MM da Data de Fechamento)
    // Para dados semanais acumulados: pega o ÚLTIMO snapshot por mês (maior Data de Fechamento)
    const monthMap = new Map<string, any>()

    for (const p of allPages) {
      const mes   = getTitle(p, 'Mês / Referência')
      const data  = getDate(p, 'Data de Fechamento')
      if (!data) continue

      const key = mesKey(mes, data)
      const existing = monthMap.get(key)

      // Mantém o registro com a data mais recente (snapshot final do mês)
      if (!existing || data > existing.data) {
        monthMap.set(key, {
          mes,
          data,
          entrada:      getNumber(p, 'Entrada Total'),
          saida:        getNumber(p, 'Saída Total'),
          fluxo:        getNumber(p, 'Fluxo Caixa Team Santiago'),
          consultoria:  getNumber(p, 'Consultoria Online'),
          personal:     getNumber(p, 'Personal Trainer'),
          gastos_fixo:  getNumber(p, 'Gastos Fixo'),
          gastos_var:   getNumber(p, 'Gastos Variáveis'),
          cartao:       getNumber(p, 'Cartão de Crédito'),
          investimento: getNumber(p, 'Investimentos'),
        })
      }
    }

    // Ordena por data e pega os últimos N meses
    const rows = Array.from(monthMap.values())
      .sort((a, b) => a.data.localeCompare(b.data))
      .filter((r) => r.entrada > 0 || r.saida > 0)
      .slice(-Math.max(1, meses))

    return json({ rows })
  } catch (e: any) {
    console.error('notion-financeiro error:', e)
    return json({ error: e.message }, 500)
  }
})
