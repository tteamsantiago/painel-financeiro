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

    // Consulta banco de dados Controle Financeiro
    const result = await notionQuery(token, DB_FINANCEIRO, {
      sorts: [{ property: 'Data de Fechamento', direction: 'ascending' }],
      page_size: 100,
    })

    const pages = result.results ?? []

    // Mapeia cada linha para um objeto normalizado
    const rows = pages
      .map((p: any) => ({
        mes:        getTitle(p, 'Mês / Referência'),
        data:       getDate(p, 'Data de Fechamento'),
        entrada:    getNumber(p, 'Entrada Total'),
        saida:      getNumber(p, 'Saída Total'),
        fluxo:      getNumber(p, 'Fluxo Caixa Team Santiago'),
        consultoria:  getNumber(p, 'Consultoria Online'),
        personal:     getNumber(p, 'Personal Trainer'),
        gastos_fixo:  getNumber(p, 'Gastos Fixo'),
        gastos_var:   getNumber(p, 'Gastos Variáveis'),
        cartao:       getNumber(p, 'Cartão de Crédito'),
        investimento: getNumber(p, 'Investimentos'),
      }))
      .filter((r: any) => r.mes || r.entrada)

    // Retorna só os últimos N meses
    const slice = rows.slice(-Math.max(1, meses))

    return json({ rows: slice })
  } catch (e: any) {
    console.error('notion-financeiro error:', e)
    return json({ error: e.message }, 500)
  }
})
