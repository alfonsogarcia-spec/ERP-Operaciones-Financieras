# Oficina Polipay

Mapa animado del equipo de agentes de IA de Polipay (Claude Code): quién trabaja, en qué tarea y en qué sesión, en vivo.

- **Stack**: Node/Express, mismo patrón que ERP-Operaciones.
- **BD**: el mismo Supabase de ERP-Operaciones, aislado en el schema `oficina` (tablas `agentes`, `tareas`, `sesiones`, `actividad`, `tokens`). El schema no se expone por la API REST de Supabase.
- **Despliegue**: servicio `oficina-polipay` del blueprint de ERP-Operaciones-Financieras (`render.yaml`), con `rootDir: oficina` y su propia URL.
- **Acceso**: login con Google, solo dominio `ALLOWED_HD`. Las computadoras que reportan usan un token propio (revocable).
- **Privacidad**: no guarda CLABEs, datos de tarjetahabientes ni KYC. El texto de las peticiones a Claude **no** se envía salvo que se active `enviar_prompt` en la configuración local.

## Desplegar (una sola vez)

1. **Commit y push solo de la oficina y el blueprint** (el repo tiene otros cambios en curso que no deben ir aquí):
   ```bash
   cd ~/polipay-conciliacion-liquidacion
   git add oficina render.yaml
   git commit -m "Oficina Polipay: nuevo servicio en el blueprint (schema oficina)"
   git push
   ```
2. **Render** → Blueprints → ERP-Operaciones-Financieras → *Sync*: aparece el servicio nuevo `oficina-polipay`.
3. **Variables en Render** (servicio `oficina-polipay` → Environment):
   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | La misma cadena de Supabase que usa conciliación (Session pooler) |
   | `GOOGLE_CLIENT_ID` | El mismo Client ID de conciliación |
   | `ALLOWED_HD` | `polipay.io` |
   | `OFICINA_ADMINS` | Tu correo (y los de quien pueda generar tokens), separados por coma |
   | `JWT_SECRET` | Lo genera Render |
4. **Google Cloud Console** → Credenciales → el OAuth Client → *Orígenes de JavaScript autorizados*: agrega la URL del servicio (p. ej. `https://oficina-polipay.onrender.com`).
5. Abre la URL, inicia sesión y verifica `/healthz` (debe decir `postgres (supabase) · schema "oficina"`).

## Conectar una computadora

1. En la oficina → pestaña **Conexiones** → genera un token para esa Mac (solo admins).
2. En esa Mac, desde el repo ERP-Operaciones-Financieras:
   ```bash
   bash oficina/cliente/instalar.sh https://oficina-polipay.onrender.com ofp_EL_TOKEN
   ```
   Esto guarda la configuración en `~/.config/oficina-polipay/config.json` (permisos 600) y agrega los hooks a `~/.claude/settings.json` (con respaldo), para que **todas** las sesiones de Claude Code de esa Mac aparezcan en la oficina.
3. En el proyecto *Equipo de Agentes polipay*, sube el roster una vez:
   ```bash
   python3 10_oficina/scripts/oficina.py roster
   ```
4. Abre una sesión nueva de Claude Code para que cargue los hooks.

Para desconectar una Mac: revoca su token en **Conexiones** o borra `~/.config/oficina-polipay/config.json`.

## Desarrollo local

```bash
npm install
npm run dev     # sin DATABASE_URL usa pglite en ./.pgdata; sin GOOGLE_CLIENT_ID entra sin login
```

Abre `http://127.0.0.1:3100`. El sitio también funciona sin servidor dentro del proyecto *Equipo de Agentes polipay* (`10_oficina/sitio`, modo local con archivos JSON).

Para probar contra el Supabase real: crea `oficina/.env` con `DATABASE_URL` (está en `.gitignore`).

## API

| Método y ruta | Auth | Uso |
|---|---|---|
| `GET /healthz` | — | Salud del servicio y de la BD |
| `GET /api/config` | — | Client ID de Google y modo |
| `POST /api/auth/google` | — | Login (cookie HttpOnly, 12 h) |
| `GET /api/estado` | sesión | Agentes, tareas, actividad y sesiones para el mapa |
| `GET/POST/DELETE /api/tokens` | sesión admin | Tokens de conexión de computadoras |
| `POST /api/ingesta/evento` | token | Eventos de los hooks (inicio, fin, sub-fin, prompt, stop) |
| `POST /api/ingesta/tarea` | token | Alta y cambio de estado de tareas (folio lo asigna el servidor) |
| `POST /api/ingesta/roster` | token | Alta/actualización del catálogo de agentes |
