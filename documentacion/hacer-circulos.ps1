Add-Type -AssemblyName System.Drawing
$dir = "c:\Users\ACER\Desktop\antigravity recursos\TAP\Aplicacion de monday\documentacion\capturas"

# origen | recorte x,y,w,h | destino | elipses "x1,y1,x2,y2" en coordenadas del original
$trabajos = @(
  @{ src='102400'; crop=@(0,0,965,645);    out='staging-1-centro-desarrollo.png';  els=@(,@(192,310,507,350)) },
  @{ src='102427'; crop=@(0,0,780,430);    out='staging-2-version-nueva.png';      els=@(,@(2,269,157,298)) },
  @{ src='102442'; crop=@(0,0,1160,535);   out='staging-3-version-creada.png';     els=@(,@(197,295,502,329)) },
  @{ src='102453'; crop=@(0,0,1165,440);   out='staging-4-funciones.png';          els=@(@(197,300,540,332),@(197,332,540,364)) },
  @{ src='102511'; crop=@(0,55,1852,840);  out='staging-5-url-receta.png';         els=@(@(206,590,1258,620),@(1750,851,1850,881)) },
  @{ src='102526'; crop=@(0,0,1160,770);   out='staging-6-url-vista.png';          els=@(,@(205,459,462,490)) },
  @{ src='102547'; crop=@(0,0,1300,560);   out='staging-7-eliminar-version.png';   els=@(,@(1124,389,1286,416)) }
)

foreach ($t in $trabajos) {
  $origen = Get-ChildItem (Join-Path $dir "originales") -Filter "*$($t.src).png" | Select-Object -First 1
  if (-not $origen) { Write-Output "  NO ENCONTRE $($t.src)"; continue }

  $img = [System.Drawing.Image]::FromFile($origen.FullName)
  $cx, $cy, $cw, $ch = $t.crop
  if ($cx + $cw -gt $img.Width)  { $cw = $img.Width  - $cx }
  if ($cy + $ch -gt $img.Height) { $ch = $img.Height - $cy }

  $bmp = New-Object System.Drawing.Bitmap($cw, $ch)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img,
      (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)),
      (New-Object System.Drawing.Rectangle($cx, $cy, $cw, $ch)),
      [System.Drawing.GraphicsUnit]::Pixel)

  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 214, 31, 31), 3.5)
  foreach ($e in $t.els) {
    $x1 = $e[0] - $cx - 5; $y1 = $e[1] - $cy - 5
    $x2 = $e[2] - $cx + 5; $y2 = $e[3] - $cy + 5
    $g.DrawEllipse($pen, $x1, $y1, ($x2 - $x1), ($y2 - $y1))
  }

  $destino = Join-Path $dir $t.out
  $bmp.Save($destino, [System.Drawing.Imaging.ImageFormat]::Png)
  $pen.Dispose(); $g.Dispose(); $bmp.Dispose(); $img.Dispose()
  Write-Output ("  {0}  ({1}x{2}, {3} circulo/s)" -f $t.out, $cw, $ch, $t.els.Count)
}

# los originales se guardan aparte, para no confundir
$orig = Join-Path $dir "originales"
if (-not (Test-Path $orig)) { New-Item -ItemType Directory $orig | Out-Null }
Get-ChildItem $dir -Filter "Captura*.png" | Move-Item -Destination $orig -Force
Write-Output "`n  originales movidos a capturas/originales/"
