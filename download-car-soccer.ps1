# download-car-soccer.ps1
# Recupere une copie locale complete de car-soccer.com (usage personnel / etude technique)
# Usage : ouvrir PowerShell dans le dossier cible, puis : .\download-car-soccer.ps1

$base = "https://car-soccer.com"
$dest = Join-Path $PSScriptRoot "car-soccer-mirror"

function Get-File($relativePath) {
    $url = "$base$relativePath"
    $outPath = Join-Path $dest ($relativePath.TrimStart('/'))
    $outDir = Split-Path $outPath -Parent
    if (!(Test-Path $outDir)) {
        New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    }
    if (Test-Path $outPath) {
        return
    }
    try {
        Invoke-WebRequest -Uri $url -OutFile $outPath -UserAgent "Mozilla/5.0" -ErrorAction Stop
        Write-Host "OK   $relativePath"
    } catch {
        Write-Host "FAIL $relativePath ($($_.Exception.Message))"
    }
}

$files = New-Object System.Collections.Generic.List[string]

# Page + bundle principal
$files.Add("/")
$files.Add("/assets/index-CxOInPcq.js")
$files.Add("/assets/index-Zw_Q3DuT.css")
$files.Add("/assets/module.no-external-lXQM_FQ3.js")   # moteur physique (custom, pas de lib connue)
$files.Add("/assets/worker-s6VATz5T.js")                 # tourne probablement la physique dans un Web Worker
$files.Add("/site.webmanifest")
$files.Add("/assets/app-icon-512-DPODCpjJ.png")
$files.Add("/android-chrome-192x192.png")

# Arene : collisions + stade
$files.Add("/assets/arena/collision/manifest.json")
for ($i = 0; $i -le 15; $i++) { $files.Add("/assets/arena/collision/mesh_$i.cmf") }
$files.Add("/assets/arena/stadium/continuous-boundary.json")
$files.Add("/assets/arena/stadium/stadium.glb")
$files.Add("/assets/arena/stadium/bank-hex-albedo.png")
$files.Add("/assets/arena/stadium/bank-hex-normal.png")

# Pads de boost
$files.Add("/assets/arena/pads/large-active.obj")
$files.Add("/assets/arena/pads/large-idle.obj")
$files.Add("/assets/arena/pads/small-active.obj")
$files.Add("/assets/arena/pads/small-idle.obj")
$files.Add("/assets/arena/pads/albedo.png")

# Voitures
$files.Add("/assets/game-car/model.gltf")
$files.Add("/assets/game-car/geometry.bin")
$files.Add("/assets/flat-car/model.glb")
$files.Add("/assets/realistic-car/details.glb")

# Audio - evenements simples
$files.Add("/assets/audio/events/reset.wav")
$files.Add("/assets/audio/vehicle/supersonic-loop.wav")
$files.Add("/assets/audio/vehicle/supersonic-enter-a.wav")
$files.Add("/assets/audio/vehicle/supersonic-enter-b.wav")
$files.Add("/assets/audio/vehicle/supersonic-enter-c.wav")
$files.Add("/assets/audio/engine/manifest.json")
$files.Add("/assets/audio/boost/start.wav")
$files.Add("/assets/audio/boost/loop.wav")
$files.Add("/assets/audio/boost/release.wav")
$files.Add("/assets/audio/engine/idle.wav")

# Audio - series numerotees
foreach ($n in 1..4) { $files.Add("/assets/audio/vehicle/jump-{0:D2}.wav" -f $n) }
foreach ($n in 1..4) { $files.Add("/assets/audio/vehicle/dodge-{0:D2}.wav" -f $n) }
foreach ($n in 1..4) { $files.Add("/assets/audio/vehicle/double-jump-{0:D2}.wav" -f $n) }
foreach ($n in 1..4) { $files.Add("/assets/audio/vehicle/wheel-impact-{0:D2}.wav" -f $n) }
foreach ($n in 1..6) { $files.Add("/assets/audio/impacts/vehicle-body-{0:D2}.wav" -f $n) }
foreach ($n in 1..6) { $files.Add("/assets/audio/impacts/vehicle-detail-{0:D2}.wav" -f $n) }
foreach ($n in 1..6) { $files.Add("/assets/audio/impacts/vehicle-hard-{0:D2}.wav" -f $n) }
$files.Add("/assets/audio/impacts/vehicle-accent-01.wav")
foreach ($n in 1..6) { $files.Add("/assets/audio/impacts/surface-detail-{0:D2}.wav" -f $n) }
foreach ($n in 1..6) { $files.Add("/assets/audio/impacts/surface-body-{0:D2}.wav" -f $n) }
foreach ($n in 1..5) { $files.Add("/assets/audio/impacts/grass-{0:D2}.wav" -f $n) }
foreach ($n in 1..6) { $files.Add("/assets/audio/impacts/arena-{0:D2}.wav" -f $n) }
foreach ($n in 1..20) { $files.Add("/assets/audio/engine/loaded-{0:D2}.wav" -f $n) }
foreach ($n in 1..20) { $files.Add("/assets/audio/engine/coast-{0:D2}.wav" -f $n) }

Write-Host "Telechargement de $($files.Count) fichiers vers $dest ..."
foreach ($f in $files) {
    if ($f -eq "/") {
        $out = Join-Path $dest "index.html"
        if (!(Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
        Invoke-WebRequest -Uri $base -OutFile $out -UserAgent "Mozilla/5.0"
        Write-Host "OK   index.html"
    } else {
        Get-File $f
    }
}

Write-Host ""
Write-Host "Termine. Prochaine etape suggeree :"
Write-Host "  npx js-beautify `"$dest\assets\index-CxOInPcq.js`" > index.beautified.js"
Write-Host "  npx js-beautify `"$dest\assets\module.no-external-lXQM_FQ3.js`" > physics.beautified.js"
