[CmdletBinding()]
param(
    [ValidateSet('chrome', 'edge', 'all')]
    [string]$Browser = 'all',
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'dist' }
$manifestPath = Join-Path $projectRoot 'extension\manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$targets = if ($Browser -eq 'all') { @('chrome', 'edge') } else { @($Browser) }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

foreach ($target in $targets) {
    $staging = Join-Path ([System.IO.Path]::GetTempPath()) ('xiaoya-package-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging | Out-Null
    # Both browsers receive exactly the same extension code and permissions.
    Copy-Item -LiteralPath (Join-Path $projectRoot 'extension') -Destination $staging -Recurse
    Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination $staging
    Copy-Item -LiteralPath (Join-Path $projectRoot 'CHANGELOG.md') -Destination $staging
    $browserName = if ($target -eq 'edge') { 'Microsoft Edge' } else { 'Google Chrome' }
    $managementUrl = if ($target -eq 'edge') { 'edge://extensions/' } else { 'chrome://extensions/' }
    $instructions = @"
小雅助手 Pro $($manifest.version) — $browserName

1. 请使用 $browserName 120 或以上版本。
2. 将本安装包完整解压到固定目录。
3. 打开 $managementUrl 并开启“开发者模式”。
4. 点击“加载未打包的扩展程序”（英文界面为 Load unpacked），选择 extension 文件夹。
5. 固定插件图标，点击图标打开侧边栏查看任务。需要开着一个已登录的小雅标签页。
6. 在侧边栏勾选视频或课件，点底部的“开始刷课”；保持刷课的小雅标签页打开，即可使用其他网页。

Chrome 与 Edge 使用同一套源码和权限。
两个浏览器的登录和扩展存储独立；请在本浏览器单独登录，不要同时运行同一账号的两个队列。
后台有效计时以平台为准。详细步骤见 README.md，本版改动见 CHANGELOG.md。
"@
    Set-Content -LiteralPath (Join-Path $staging "安装-$target.txt") -Value $instructions -Encoding utf8
    $filename = if ($target -eq 'edge') { "xiaoya-course-helper-edge-v$($manifest.version).zip" } else { "xiaoya-course-helper-v$($manifest.version).zip" }
    $destination = Join-Path $OutputDirectory $filename
    Compress-Archive -LiteralPath @((Join-Path $staging 'extension'), (Join-Path $staging 'README.md'), (Join-Path $staging 'CHANGELOG.md'), (Join-Path $staging "安装-$target.txt")) -DestinationPath $destination -Force
    [pscustomobject]@{ Browser = $browserName; Version = $manifest.version; Package = (Get-Item -LiteralPath $destination).FullName }
}
