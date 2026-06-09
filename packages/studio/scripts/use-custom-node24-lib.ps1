param(
  [Parameter(Mandatory = $true)]
  [string] $LibNodePath
)

$ErrorActionPreference = "Stop"

$studioRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$target = Join-Path $studioRoot "android/app/src/main/jniLibs/arm64-v8a/libnode.so"
$source = Resolve-Path -LiteralPath $LibNodePath

if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "libnode.so not found: $source"
}

$sourceItem = Get-Item -LiteralPath $source
if ($sourceItem.Length -lt 10MB) {
  throw "The selected libnode.so is suspiciously small ($($sourceItem.Length) bytes)."
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force

Write-Host "Installed custom Node.js Mobile library:"
Write-Host "  $target"
Write-Host ""
Write-Host "Next verification commands:"
Write-Host "  pnpm --filter @actalk/inkos-studio run android:runtime:audit"
Write-Host "  pnpm --filter @actalk/inkos-studio run android:apk"
