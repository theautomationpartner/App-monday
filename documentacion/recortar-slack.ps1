# Recorta las imagenes que dejo hacer-capturas-slack.js.
#
# El HTML se dibuja sobre un fondo magenta a proposito: aca se busca el
# rectangulo de todo lo que NO es magenta y se recorta ahi. Asi cada mensaje
# queda a su alto exacto sin tener que adivinarlo de antemano.

Add-Type -AssemblyName System.Drawing
$dir = Join-Path $PSScriptRoot "capturas"
$tmp = Join-Path $PSScriptRoot ".tmp-slack"
$margen = 0

Get-ChildItem $tmp -Filter *.png | ForEach-Object {
  $img = New-Object System.Drawing.Bitmap($_.FullName)

  # el fondo se toma de la esquina, no se asume
  $fondo = $img.GetPixel(0, 0)
  $x1 = $img.Width; $y1 = $img.Height; $x2 = -1; $y2 = -1

  for ($y = 0; $y -lt $img.Height; $y++) {
    for ($x = 0; $x -lt $img.Width; $x++) {
      $p = $img.GetPixel($x, $y)
      if ($p.R -ne $fondo.R -or $p.G -ne $fondo.G -or $p.B -ne $fondo.B) {
        if ($x -lt $x1) { $x1 = $x }
        if ($y -lt $y1) { $y1 = $y }
        if ($x -gt $x2) { $x2 = $x }
        if ($y -gt $y2) { $y2 = $y }
      }
    }
  }

  if ($x2 -lt 0) { Write-Output "  $($_.Name): todo fondo, salteada"; $img.Dispose(); return }

  $x1 = [Math]::Max(0, $x1 - $margen); $y1 = [Math]::Max(0, $y1 - $margen)
  $x2 = [Math]::Min($img.Width - 1,  $x2 + $margen)
  $y2 = [Math]::Min($img.Height - 1, $y2 + $margen)
  $w = $x2 - $x1 + 1; $h = $y2 - $y1 + 1

  # el recorte va justo al borde y despues se apoya sobre un lienzo gris Slack,
  # asi el margen que rodea al mensaje es del color de Slack y no del centinela
  $pad = 14
  $bmp = New-Object System.Drawing.Bitmap(($w + 2*$pad), ($h + 2*$pad))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(255, 26, 29, 33))   # el gris de Slack
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle($pad, $pad, $w, $h)),
                     (New-Object System.Drawing.Rectangle($x1, $y1, $w, $h)),
                     [System.Drawing.GraphicsUnit]::Pixel)

  $bmp.Save((Join-Path $dir $_.Name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
  Write-Output ("  {0}  ({1}x{2})" -f $_.Name, ($w + 2*$pad), ($h + 2*$pad))
}
