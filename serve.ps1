# Serve the dashboard at http://localhost:8771 (right-click > Run with PowerShell).
# Opening index.html directly also works; use this only if your browser restricts file:// pages.
param([int]$Port = 8771)
Add-Type -AssemblyName System.Web
$root = $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Post Pipeline Dashboard -> http://localhost:$Port/  (Ctrl+C to stop)"
$mime = @{ '.html'='text/html; charset=utf-8'; '.css'='text/css'; '.js'='application/javascript'; '.json'='application/json';
           '.png'='image/png'; '.jpg'='image/jpeg'; '.svg'='image/svg+xml'; '.ico'='image/x-icon'; '.md'='text/plain' }
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $path = [System.Web.HttpUtility]::UrlDecode($ctx.Request.Url.AbsolutePath)
    if ($path -eq '/') { $path = '/index.html' }
    $full = [System.IO.Path]::GetFullPath((Join-Path $root ($path -replace '/', '\')))
    if ($full.StartsWith($root) -and (Test-Path $full -PathType Leaf)) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ctx.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
  } catch {
    try { $ctx.Response.StatusCode = 500 } catch {}
  } finally {
    try { $ctx.Response.OutputStream.Close() } catch {}
  }
}
