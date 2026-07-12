<#
.SYNOPSIS
  Verifies Authenticode signing + RFC3161 timestamp on dociai's Windows artifacts (#73).

.DESCRIPTION
  Checked, in order, per file:
    1. Get-AuthenticodeSignature reports Status -eq 'Valid' (built into PowerShell, no extra
       install required — works on every windows-latest GitHub Actions runner unconditionally).
    2. A SignerCertificate is present.
    3. A TimeStamperCertificate is present (an RFC3161/Authenticode timestamp — without one the
       signature becomes invalid the moment the signing certificate itself expires).
    4. If signtool.exe (Windows SDK) is on PATH, `signtool verify /pa /v` is also run as a
       stricter, independent cross-check. Not all runners have the SDK installed, so this step is
       best-effort and only skipped (not failed) when signtool.exe is absent.

  This script assumes its input files were actually signed (the caller only invokes it when
  WINDOWS_CERTIFICATE_PFX_BASE64/WINDOWS_CERTIFICATE_PASSWORD were present — see
  .github/workflows/package.yml and docs/signing.md); it does not itself decide whether signing
  should have happened.

.PARAMETER Path
  One or more paths to .exe/.dll/.msi files to verify.

.EXAMPLE
  pwsh scripts/release/verify-windows-signing.ps1 dist/release/win-unpacked/dociai.exe
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$Path
)

$ErrorActionPreference = 'Stop'
$failures = New-Object System.Collections.Generic.List[string]

if ($Path.Count -eq 0) {
    Write-Error "Usage: verify-windows-signing.ps1 <path-to-exe-or-dll> [<path> ...]"
    exit 2
}

foreach ($file in $Path) {
    if (-not (Test-Path -LiteralPath $file)) {
        Write-Host "FAIL | verify-windows-signing | file not found: $file"
        $failures.Add($file)
        continue
    }

    $resolved = (Resolve-Path -LiteralPath $file).Path
    Write-Host "INFO | verify-windows-signing | checking $resolved"

    $sig = Get-AuthenticodeSignature -LiteralPath $resolved

    if ($sig.Status -ne 'Valid') {
        Write-Host "FAIL | verify-windows-signing | $resolved signature status = $($sig.Status): $($sig.StatusMessage)"
        $failures.Add($resolved)
        continue
    }

    if (-not $sig.SignerCertificate) {
        Write-Host "FAIL | verify-windows-signing | $resolved has a 'Valid' status but no SignerCertificate"
        $failures.Add($resolved)
        continue
    }
    Write-Host "PASS | verify-windows-signing | $resolved signed by: $($sig.SignerCertificate.Subject)"

    if ($sig.TimeStamperCertificate) {
        Write-Host "PASS | verify-windows-signing | $resolved has an RFC3161 timestamp from: $($sig.TimeStamperCertificate.Subject)"
    }
    else {
        Write-Host "FAIL | verify-windows-signing | $resolved is signed but carries no timestamp (signature invalidates when the certificate expires)"
        $failures.Add($resolved)
        continue
    }

    $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($signtool) {
        & $signtool.Path verify /pa /v $resolved
        if ($LASTEXITCODE -ne 0) {
            Write-Host "FAIL | verify-windows-signing | 'signtool verify /pa' exited $LASTEXITCODE for $resolved"
            $failures.Add($resolved)
            continue
        }
        Write-Host "PASS | verify-windows-signing | signtool verify /pa passed for $resolved"
    }
    else {
        Write-Host "INFO | verify-windows-signing | signtool.exe not found on PATH; skipped supplemental signtool verification"
    }
}

if ($failures.Count -gt 0) {
    Write-Host "FAIL | verify-windows-signing | $($failures.Count) of $($Path.Count) file(s) failed verification"
    exit 1
}

Write-Host "PASS | verify-windows-signing | all $($Path.Count) file(s) verified"
exit 0
