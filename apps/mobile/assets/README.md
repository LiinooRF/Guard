# Identidad visual del shell Android (#114)

Los **SVG de este directorio son las fuentes**. Los PNG que consume Expo se
exportan desde ellos y **se commitean**: el build no los genera.

## Por qué el icono no es del cliente

VoxIA Control es multi-tenant white-label, pero en Google Play hay **una sola
ficha y un solo APK**. El icono, el nombre y el splash son de la plataforma y no
se pueden pintar por empresa: cuando la app arranca todavía no sabe a qué
empresa pertenece quien la abrió — eso se resuelve después del login.

La marca del cliente (`tenantBrandingSchema` de `@voxia/shared`) vive **dentro
del WebView**. Si comercial promete "la app con el logo del cliente", eso
significa ficha propia + cuenta de desarrollador propia + revisión propia por
cada cliente, con su verificación de identidad y sus semanas de calendario. No
es una opción de configuración.

## Qué exportar

| PNG | Tamaño | Fuente | Fondo | Dónde se usa |
|---|---|---|---|---|
| `icon.png` | 1024×1024 | `icon.svg` | opaco `#1f3b73` | `icon` en app.config.ts |
| `adaptive-icon-foreground.png` | 1024×1024 | `adaptive-icon-foreground.svg` | **transparente** | `android.adaptiveIcon.foregroundImage` |
| `adaptive-icon-monochrome.png` | 1024×1024 | `adaptive-icon-monochrome.svg` | **transparente** | `android.adaptiveIcon.monochromeImage` |
| `splash-icon.png` | 1024×1024 | `splash-icon.svg` | **transparente** | plugin `expo-splash-screen` |
| `play-icon-512.png` | 512×512 | `icon.svg` | opaco, **sin alfa** | ficha de Play Store |

Comando de exportación (`rsvg-convert`, de `librsvg`; también sirve
`inkscape --export-type=png`):

```bash
cd apps/mobile/assets
rsvg-convert -w 1024 -h 1024 icon.svg                      -o icon.png
rsvg-convert -w 1024 -h 1024 adaptive-icon-foreground.svg  -o adaptive-icon-foreground.png
rsvg-convert -w 1024 -h 1024 adaptive-icon-monochrome.svg  -o adaptive-icon-monochrome.png
rsvg-convert -w 1024 -h 1024 splash-icon.svg               -o splash-icon.png
rsvg-convert -w  512 -h  512 icon.svg                      -o play-icon-512.png
```

Si falta alguno, `app.config.ts` avisa por consola en local y **falla los builds
de `preview` y `production`**. Es a propósito: sin ese corte, Expo sustituye en
silencio por el icono por defecto y el logo de Expo se descubre cuando la ficha
ya está publicada.

## Las tres reglas que se rompen siempre

1. **La capa frontal del icono adaptativo no lleva fondo.** El color va en
   `adaptiveIcon.backgroundColor`. Con fondo propio, el launcher recorta un
   cuadrado en lugar de la forma del sistema.
2. **Zona segura del adaptativo: círculo central de ~626 px de 1024.** El resto
   se lo puede comer la máscara del fabricante. Por eso el escudo va escalado a
   0.82; a tamaño completo se ve mordido en Samsung y en Xiaomi.
3. **La capa monocroma solo tiene forma, no tonos.** Android la recolorea con el
   tema: cualquier `fill-opacity` se vuelve un bloque sólido y el escudo queda
   como una mancha.

## Assets de la ficha que NO se generan acá

El gráfico de cabecera (1024×500) y las capturas de pantalla salen de la app
funcionando, no de un SVG. Están listados en `docs/play-store.md` con sus
requisitos exactos. Las capturas **no pueden mostrar datos reales de un
tenant**: se toman con las cuentas demo.
