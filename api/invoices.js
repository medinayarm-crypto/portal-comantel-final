const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

module.exports = async (req, res) => {
  const doc = req.query.doc;
  if (!doc) return res.status(400).json({ ok: false, message: "Falta cédula" });

  const baseUrl = process.env.URL_FACTURACION || 'https://wisphub.io';
  const apiKey = process.env.KEY_FACTURACION;
  const adminCedula = process.env.ADMIN_CEDULA;

  if (!apiKey) return res.status(500).json({ ok: false, message: "KEY_FACTURACION no configurada" });

  // ✅ Verificar si es cédula de administrador
  if (doc === adminCedula) {
    return res.status(200).json({
      ok: true,
      isAdmin: true,
      message: "Acceso administrativo concedido"
    });
  }

  try {
    // PASO 1: Buscar email por cédula
    let email = null;
    const cacheKey = `cedula:${doc}`;
    const cached = cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      email = cached.email;
    } else {
      const searchRes = await fetch(`${baseUrl}/clientes/?buscar=${encodeURIComponent(doc)}`, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
      });

      if (!searchRes.ok) throw new Error(`Búsqueda falló: ${searchRes.status}`);
      
      const searchData = await searchRes.json();
      const clientes = searchData.data || searchData.results || [];
      const cliente = clientes.find(c => 
        c.dni === doc || c.cedula === doc || c.document === doc ||
        c['DNI/C.I./RIF'] === doc || c['DNI/C.I./C.C./RIF'] === doc
      );

      if (!cliente) return res.status(404).json({ ok: false, message: `Cliente con cédula ${doc} no encontrado` });

      email = cliente.email || cliente.usuario || cliente.Usuario;
      if (!email.includes('@')) email = `${email}@comantel`;
      cache.set(cacheKey, { email, timestamp: Date.now() });
    }

    // PASO 2: Obtener detalle del cliente
    const detailRes = await fetch(`${baseUrl}/clientes/ver/${encodeURIComponent(email)}/`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
    });

    if (!detailRes.ok) throw new Error(`Detalle falló: ${detailRes.status}`);
    const clientData = await detailRes.json();

    const allInvoices = clientData.facturas || clientData.invoices || clientData.historial_pagos || [];
    const pending = allInvoices.filter(f => 
      f.estado === 'Pendiente de pago' || f.status === 'PENDING' || f.Estado === 'Pendiente'
    );
    const processed = allInvoices.filter(f => 
      f.estado === 'Pagada' || f.status === 'PAID' || f.Estado === 'Pagada'
    );

    const totalPending = pending.reduce((sum, f) => sum + (parseFloat(f.Total || f.amount || f.monto) || 0), 0);

    res.status(200).json({
      ok: true,
      client_name: clientData.nombre || clientData.Nombre || email.split('@')[0],
      cedula: doc,
      invoices: allInvoices,
      pending_invoices: pending,
      processed_invoices: processed,
      total_pending: totalPending,
      processed_count: processed.length,
      pending_count: pending.length,
      bank_data: {
        bnc: { telefono: process.env.BNC_TELEFONO || '-', cedula: process.env.BNC_CEDULA || '-' },
        banplus: { telefono: process.env.BANPLUS_TELEFONO || '-', cedula: process.env.BANPLUS_CEDULA || '-' }
      }
    });

  } catch (error) {
    console.error('Error API:', error.message);
    res.status(500).json({ ok: false, message: error.message });
  }
};
