# InvoiceNudge AI

SaaS de gestión de facturas con recordatorios impulsados por IA, automatizaciones programadas y envío de correo real. Backend en Node.js, base de datos persistente SQLite, autenticación JWT y frontend responsive con modo claro/oscuro.

## Arquitectura

- **Backend:** Node.js + Express
- **Base de datos:** SQLite (`data/invoicenudge.sqlite`) — persistente, sin servicios externos
- **Autenticación:** JWT en cookies/header + bcrypt, sesiones persistentes en `localStorage`
- **Frontend:** SPA vanilla JS/CSS, servido por Express (sin paso de compilación)
- **IA:** Proveedor configurable (OpenRouter-compatible) con fallback a plantillas; claves API solo en backend
- **Correo:** Nodemailer SMTP, solo cuando está configurado (no simula envíos)
- **Automatizaciones:** programador en proceso (`setInterval`) que ejecuta automatizaciones vencidas

## Instalación rápida

```bash
cd /ruta/InvoiceNudge-AI
npm install
cp .env.example .env
# edita .env si deseas configurar IA o SMTP
npm start
```

El servidor arranca en `http://localhost:3000`. La base de datos se crea automáticamente en `data/invoicenudge.sqlite`.

## Variables de entorno (`.env`)

| Variable | Descripción | Obligatoria |
|---|---|---|
| `PORT` | Puerto del servidor (default 3000) | No |
| `JWT_SECRET` | Secreto para firmar tokens JWT | Sí (cambia en producción) |
| `JWT_EXPIRES` | Expiración del token (default 7d) | No |
| `AI_PROVIDER` | `openrouter` para proveedor real, `none` para plantillas | No |
| `AI_API_KEY` | Clave API de IA (solo backend) | No |
| `AI_BASE_URL` | URL base del proveedor IA | No |
| `AI_MODEL` | Modelo de IA (default `openai/gpt-4o-mini`) | No |
| `STRIPE_PUBLISHABLE_KEY` | Clave pública de Stripe | No |
| `STRIPE_SECRET_KEY` | Clave secreta de Stripe | No |
| `SCHEDULER_INTERVAL_MS` | Intervalo del programador (ms, default 60000) | No |

## Credenciales e integraciones pendientes

- **IA:** configura `AI_PROVIDER=openrouter`, `AI_API_KEY` y `AI_BASE_URL` para usar un proveedor real. Sin ellas, el sistema usa plantillas y lo comunica claramente en la UI.
- **Correo:** configura SMTP en Ajustes → Configuración de correo (host, puerto, usuario, contraseña, remitente). Si no se configura, las automatizaciones registran los recordatorios como "pendientes" y no envían correo real.
- **Pagos:** define `STRIPE_PUBLISHABLE_KEY`/`STRIPE_SECRET_KEY` para habilitar checkout de planes. Sin configurar, los planes se gestionan localmente sin cobros reales.

## Endpoints principales

`POST /api/auth/register` — registro  
`POST /api/auth/login` — login (devuelve JWT)  
`POST /api/auth/logout` — logout  
`GET /api/auth/profile` — perfil  
`PUT /api/auth/profile` — actualizar perfil  
`POST /auth/forgot-password` / `POST /auth/reset-password` — recuperación  
`GET /auth/verify-email?token=` — verificación de correo  

`GET/POST /api/invoices` — listar/crear facturas  
`GET/PUT/DELETE /api/invoices/:id` — detalle/editar/eliminar  
`PATCH /api/invoices/:id/pay` — marcar pagada  
`GET /api/invoices/stats` — estadísticas del dashboard  

`GET/POST /api/clients` — clientes  
`GET/PUT/DELETE /api/clients/:id`  

`GET/POST /api/reminders` — recordatorios  
`POST /api/reminders/generate` — generar con IA o plantilla  
`GET /api/reminders/types` — tipos y tonos disponibles  

`GET/POST /api/automations` — automatizaciones  
`POST /api/automations/:id/toggle` — activar/pausar  

`GET/POST /api/email/configure` — SMTP (solo backend)  
`GET /api/email/history` — historial de envíos  
`POST /api/email/send-test` — prueba de correo  

`GET/PUT /api/settings` — ajustes de usuario/empresa  
`GET /api/settings/subscription` — plan y uso  

## Seguridad

- Validación de entrada en servidor para todos los endpoints.
- Cada consulta filtra por `user_id`: un usuario nunca ve datos de otro.
- Rutas privadas protegidas por JWT.
- Claves de IA y SMTP almacenadas solo en el backend; nunca se envían al frontend.
- Rate limiting en `/api/`.
- Límites de uso por plan (Free/Pro/Business).

## Pruebas obligatorias (manuales)

1. Registro: crear cuenta → recibe JWT y redirige al dashboard.
2. Login: credenciales correctas crean sesión persistente.
3. Logout: borra token y redirige a login.
4. Recuperación de contraseña: forgot-password devuelve mensaje genérico (no revela si el email existe).
5. Crear factura → aparece en lista y dashboard.
6. Editar y eliminar factura → cambios persisten.
7. Persistencia: recargar la página mantiene la sesión y los datos.
8. Aislamiento de usuarios: crear dos usuarios; cada uno ve solo sus facturas.
9. Generar recordatorio IA → mensaje generado (plantilla si no hay proveedor).
10. Error de conexión: sin servidor, los fallos se muestran como mensajes de error, no silenciosos.

## Despliegue

El proyecto es un proceso Node.js estándar. Desplegar en cualquier proveedor que ejecute Node (Railway, Render, Fly.io, etc.), definir `PORT`, `JWT_SECRET` y, opcionalmente, variables de IA/SMTP/Stripe. La base de datos SQLite se guarda en disco persistente.

## Licencia

MIT
