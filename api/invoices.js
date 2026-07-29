// Caché en memoria para mapeo cédula → email (1 hora TTL)
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

module.exports = async (req, res) => {
  const doc = req.query.doc; // Ej: V18055316
  if (!doc) return res.status(400).json({ ok: false, message: "Falta cédula" });

  // ✅ URL CORREGIDA SEGÚN CAPTURAS F12 Y DOCUMENTACIÓN
  // Los endpoints /clientes/ y /clientes/ver/ viven en wisphub.io, NO en api.wisphub.io
  const baseUrl = process.env.URL_FACTURACION || 'https://wisphub.io';
  const apiKey = process.env.KEY_FACTURACION;
  const adminCedula = process.env.ADMIN_CEDULA;

  if (!apiKey) {
    return res.status(500).json({ ok: false, message: "KEY_FACTURACION no configurada en Vercel" });
  }

  // ✅ ACCESO ADMIN POR CÉDULA
  if (adminCedula && doc === adminCedula) {
    return res.status(200).json({
      ok: true,
      isAdmin: true,
      message: "Acceso administrativo concedido"
    });
  }

  try {
    // ==========================================
    // PASO 1: Buscar email por cédula (con caché)
    // ==========================================
    let email = null;
    const cacheKey = `cedula:${doc}`;
    const cached = cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      email = cached.email;
      console.log(`📦 Caché hit para ${doc} → ${email}`);
    } else {
      console.log(`🔍 Buscando cédula ${doc} en ${baseUrl}/clientes/...`);

      const searchUrl = `${baseUrl}/clientes/?buscar=${encodeURIComponent(doc)}`;
      const searchRes = await fetch(searchUrl, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      if (!searchRes.ok) {
        const errText = await searchRes.text().catch(() => '');
        console.error(`❌ Búsqueda falló (${searchRes.status}):`, errText.substring(0, 300));
        throw new Error(`Búsqueda de cliente falló: HTTP ${searchRes.status}`);
      }

      const searchData = await searchRes.json();
      const clientes = searchData.data || searchData.results || searchData.clientes || [];

      // Búsqueda exhaustiva en múltiples campos posibles
      const cliente = clientes.find(c =>
        c.dni === doc ||
        c.cedula === doc ||
        c.document === doc ||
        c['DNI/C.I./RIF'] === doc ||
        c['DNI/C.I./C.C./RIF'] === doc ||
        c.identificacion === doc
      );

      if (!cliente) {
        return res.status(404).json({
          ok: false,
          message: `No se encontró ningún cliente con cédula ${doc} en Wisphub`
        });
      }

      // Construir email interno @comantel
      email = cliente.email || cliente.usuario || cliente.Usuario || cliente.user;
      if (!email) {
        return res.status(404).json({
          ok: false,
          message: `Cliente encontrado pero sin email/usuario asociado`
        });
      }
      if (!email.includes('@')) email = `${email}@comantel`;

      // Guardar en caché
      cache.set(cacheKey, { email, timestamp: Date.now() });
      console.log(`✅ Email resuelto: ${email}`);
    }

    // ==========================================
    // PASO 2: Obtener detalle completo del cliente
    // ==========================================
    const detailUrl = `${baseUrl}/clientes/ver/${encodeURIComponent(email)}/`;
    console.log(`📋 Consultando detalle: ${detailUrl}`);

    const detailRes = await fetch(detailUrl, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    if (!detailRes.ok) {
      const errText = await detailRes.text().catch(() => '');
      console.error(`❌ Detalle falló (${detailRes.status}):`, errText.substring(0, 300));
      throw new Error(`Consulta de detalle falló: HTTP ${detailRes.status}`);
    }

    const clientData = await detailRes.json();

    // ==========================================
    // PASO 3: Extraer y clasificar facturas
    // ==========================================
    const allInvoices = clientData.facturas ||
                        clientData.invoices ||
                        clientData.historial_pagos ||
                        clientData.Historial_de_Pagos ||
                        clientData.pagos ||
                        [];

    const pending = allInvoices.filter(f =>
      f.estado === 'Pendiente de pago' ||
      f.status === 'PENDING' ||
      f.Estado === 'Pendiente' ||
      f.Estado_Factura === 'Pendiente de pago' ||
      f.estado_factura === 'pendiente'
    );

    const processed = allInvoices.filter(f =>
      f.estado === 'Pagada' ||
      f.status === 'PAID' ||
      f.Estado === 'Pagada' ||
      f.Estado_Factura === 'Pagada' ||
      f.estado_factura === 'pagada'
    );

    const totalPending = pending.reduce((sum, f) =>
      sum + (parseFloat(f.Total || f.amount || f.monto || f.total || f.valor) || 0), 0
    );

    // ==========================================
    // PASO 4: Respuesta completa al frontend
    // ==========================================
    res.status(200).json({
      ok: true,
      isAdmin: false,
      client_name: clientData.nombre || clientData.Nombre || clientData.name || email.split('@')[0],
      cedula: doc,
      email_internal: email, // Solo para debug backend, NO exponer en UI
      invoices: allInvoices,
      pending_invoices: pending,
      processed_invoices: processed,
      total_pending: totalPending,
      processed_count: processed.length,
      pending_count: pending.length,
      services: clientData.services || clientData.Servicios || [],
      bank_data: {
        bnc: {
          telefono: process.env.BNC_TELEFONO || '-',
          cedula: process.env.BNC_CEDULA || '-'
        },
        banplus: {
          telefono: process.env.BANPLUS_TELEFONO || '-',
          cedula: process.env.BANPLUS_CEDULA || '-'
        }
      }
    });

  } catch (error) {
    console.error('💥 Error fatal en invoices.js:', error.message);
    res.status(500).json({
      ok: false,
      message: `Error interno: ${error.message}`
    });
  }
};
