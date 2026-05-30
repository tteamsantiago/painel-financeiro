$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")

Set-Location "C:\Users\felip\Desktop\Projeto Claude\painel-financeiro"

Write-Host "Enviando alteracoes para o GitHub..." -ForegroundColor Cyan
git add .
git commit -m "atualizacao painel"
git push origin master

Write-Host "Publicando no Vercel..." -ForegroundColor Cyan
vercel --prod --yes

Write-Host ""
Write-Host "Pronto! Site atualizado em: https://painel-financeiro-lilac.vercel.app" -ForegroundColor Green
