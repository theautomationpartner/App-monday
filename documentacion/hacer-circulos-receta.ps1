Add-Type -AssemblyName System.Drawing
$dir = "c:\Users\ACER\Desktop\antigravity recursos\TAP\Aplicacion de monday\documentacion\capturas"
$src = Get-ChildItem (Join-Path $dir "originales") -Filter "*102511.png" | Select-Object -First 1
$img = [System.Drawing.Image]::FromFile($src.FullName)

# La pantalla es muy ancha y el panel de vista previa del medio esta vacio.
# Se saca esa franja y se pegan los dos lados, con un corte visible en el medio
# para que se note que falta un pedazo.
$y0 = 55; $alto = 840
$izqW = 1300              # contenido: sidebar + formulario + campo URL
$derX = 1655; $derW = 197 # los botones Descartar / Guardar cambios
$gap  = 16

$ancho = $izqW + $gap + $derW
$bmp = New-Object System.Drawing.Bitmap($ancho, $alto)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::White)

$g.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, $izqW, $alto)),
                   (New-Object System.Drawing.Rectangle(0, $y0, $izqW, $alto)),
                   [System.Drawing.GraphicsUnit]::Pixel)
# de la derecha solo interesa la barra de botones de abajo
$barraAlto = 95
$g.DrawImage($img, (New-Object System.Drawing.Rectangle(($izqW + $gap), ($alto - $barraAlto), $derW, $barraAlto)),
                   (New-Object System.Drawing.Rectangle($derX, ($y0 + $alto - $barraAlto), $derW, $barraAlto)),
                   [System.Drawing.GraphicsUnit]::Pixel)

# el corte, punteado, para que se vea que la imagen esta cortada
$penCorte = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 168, 175, 185), 2)
$penCorte.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
$g.DrawLine($penCorte, ($izqW + [int]($gap/2)), 0, ($izqW + [int]($gap/2)), $alto)

$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 214, 31, 31), 3.5)
$g.DrawEllipse($pen, 201, (585 - $y0), 1062, 40)                        # campo URL de ejecucion
$g.DrawEllipse($pen, ($izqW + $gap + 100), (846 - $y0), 100, 40)        # boton Guardar cambios

$bmp.Save((Join-Path $dir "staging-5-url-receta.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$penCorte.Dispose(); $pen.Dispose(); $g.Dispose(); $bmp.Dispose(); $img.Dispose()
Write-Output ("  staging-5-url-receta.png  ({0}x{1})" -f $ancho, $alto)
