$input_data = $input | Out-String

$projectRoot = "c:\BUSINESS\ai cue pro++"

Set-Location $projectRoot

$status = git status --porcelain 2>&1
if (-not $status) {
    Write-Output '{"additional_context": ""}'
    exit 0
}

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
git add . 2>&1 | Out-Null
git commit -m "auto: $timestamp" 2>&1 | Out-Null
git push origin main 2>&1 | Out-Null

Write-Output '{"additional_context": ""}'
exit 0
