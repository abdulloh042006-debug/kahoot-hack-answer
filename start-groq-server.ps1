$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not $env:GROQ_API_KEY) {
  $env:GROQ_API_KEY = (Read-Host "Groq API keyni kiriting").Trim()
} else {
  $env:GROQ_API_KEY = $env:GROQ_API_KEY.Trim()
}
$env:GROQ_MODEL = "openai/gpt-oss-120b"
node ".\ai-server.mjs"
