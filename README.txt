# Bobyka - Tienda + Mercado Pago + Supabase + Panel

## Qué incluye

- Tienda Bobyka.
- Imagen de categorías `bobyka-categorias.png`.
- Botones de Remeras, Tazas, Gorros y Platos.
- Modal de personalización.
- Cantidad, talle, datos del cliente y subida del logo.
- Pedido guardado en Supabase.
- Logo guardado en bucket privado de Supabase Storage.
- Checkout Pro de Mercado Pago.
- Webhook de Mercado Pago.
- Verificación de firma del webhook cuando `MP_WEBHOOK_SECRET` está configurado.
- Verificación del estado, moneda y monto del pago antes de marcar el pedido como recibido.
- Panel privado en `/admin`.
- Estadísticas de pedidos, pagos y facturación.
- Filtro por estado y búsqueda.
- Cambio de estado del pedido.
- Botón para descargar el diseño del cliente mediante URL firmada temporal.

## 1. Supabase

1. Creá un proyecto.
2. Abrí SQL Editor.
3. Ejecutá `supabase.sql`.
4. Copiá la URL del proyecto y la `service_role key` a `.env`.
5. El bucket `disenos` queda privado.

No pongas `SUPABASE_SERVICE_ROLE_KEY` en el frontend.

## 2. Mercado Pago

1. Creá una aplicación en Tus integraciones.
2. Usá el Access Token del ambiente que corresponda.
3. Configurá Webhooks para pagos.
4. La URL productiva será:
   `https://TU-DOMINIO.COM/api/mercadopago/webhook`
5. Copiá la clave secreta generada por Mercado Pago en `MP_WEBHOOK_SECRET`.

Mercado Pago recomienda Webhooks y permite validar la firma mediante `x-signature`.

## 3. Instalar

Necesitás Node.js 18 o superior.

En esta carpeta:

    npm install

Luego copiá `.env.example` como `.env` y completalo.

## 4. Ejecutar

    npm start

Tienda:
    http://localhost:3000

Panel:
    http://localhost:3000/admin

## 5. Seguridad

- El bucket de diseños es privado.
- Los logos se sirven al administrador mediante URL firmada de duración limitada.
- El Access Token de Mercado Pago y la Service Role Key permanecen en el servidor.
- Cambiá `ADMIN_PASSWORD` y `ADMIN_COOKIE_SECRET`.
- En producción usá HTTPS.
- Configurá `NODE_ENV=production`.
- `PUBLIC_URL` debe ser la URL HTTPS real.

## Flujo final

Cliente:
producto → cantidad → logo → datos → Mercado Pago

Servidor:
pedido pendiente → crea preferencia → Mercado Pago → webhook → verifica pago → pedido recibido

Administrador:
`/admin` → ve pedido → descarga logo → cambia estado:
recibido → en producción → listo → entregado
