import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { campos, contexto } = await req.json()

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY não configurada nos secrets do Supabase.' }, 500)

    if (!campos || campos.length === 0) return json({ error: 'Nenhum campo enviado.' }, 400)
    if (!contexto?.trim()) return json({ error: 'Dados do aluno não informados.' }, 400)

    const prompt = `Você é um assistente que preenche contratos. Abaixo estão os campos em vermelho que precisam ser substituídos no contrato, e os dados do aluno/contrato fornecidos pelo usuário.

CAMPOS EM VERMELHO DO CONTRATO (cada um precisa ser substituído pelo valor correto):
${campos.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n')}

DADOS FORNECIDOS PELO USUÁRIO:
${contexto}

Retorne SOMENTE um JSON válido, sem explicações, com este formato:
{
  "campos": {
    "texto vermelho original exato": "valor preenchido",
    "texto vermelho original exato": "valor preenchido"
  }
}

Regras:
- A chave deve ser EXATAMENTE igual ao texto vermelho original (copiado palavra por palavra)
- O valor deve ser o texto que vai substituir aquele campo no contrato, já formatado corretamente
- Se uma informação não foi fornecida, use o campo original como valor (sem alterar)
- Para campos de data, use o formato DD/MM/AAAA
- Para campos de valor monetário, use o formato R$X.XXX,XX`

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(`Claude API ${response.status}: ${(err as any).error?.message || response.statusText}`)
    }

    const data = await response.json()
    const text = data.content?.[0]?.text || ''

    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('Resposta da IA não contém JSON válido.')

    const parsed = JSON.parse(match[0])
    return json(parsed)
  } catch (e: any) {
    console.error('contrato-ia error:', e)
    return json({ error: e.message }, 500)
  }
})
