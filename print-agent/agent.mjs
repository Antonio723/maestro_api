// Orquestra — Agente de Impressão (local, Windows)
// ----------------------------------------------------------------------------
// Roda na MÁQUINA cliente (a estação Windows onde fica a impressora). O backend
// está na VPS (Linux) e não enxerga a impressora da LAN, então a impressão é
// feita aqui: o navegador manda o ZPL + o nome do compartilhamento e este agente
// imprime cru via spooler do Windows (copy /B \\host\compartilhamento).
//
// Uso:  node agent.mjs            (ou execute iniciar-agente.bat)
// Porta: env PORT (padrão 9110). Escuta só em 127.0.0.1 (somente o navegador local).

import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';

const PORT = Number(process.env.PORT || 9110);

// Nome de compartilhamento e host válidos (evita injeção / UNC malformada).
function assertSafeShareName(name) {
  if (!/^[\w .$()+#-]{1,80}$/.test(name)) throw new Error('Nome de compartilhamento inválido.');
}
function assertSafeHost(host) {
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(host)) throw new Error('Host inválido (use só nome da máquina ou IP, sem ":porta").');
}

// Imprime ZPL cru numa impressora COMPARTILHADA do Windows.
async function printRaw(data, printer, host = 'localhost') {
  assertSafeShareName(printer);
  assertSafeHost(host);
  if (process.platform !== 'win32') throw new Error('O agente de impressão só funciona no Windows.');

  const dir = await mkdtemp(resolve(os.tmpdir(), 'orq-agent-'));
  const tmp = resolve(dir, `label-${Date.now()}.zpl`);
  await writeFile(tmp, data, 'latin1');
  try {
    await new Promise((res, rej) => {
      execFile(
        'cmd.exe',
        ['/c', 'copy', '/B', tmp, `\\\\${host}\\${printer}`],
        { windowsHide: true, timeout: 15000 },
        (err, stdout, stderr) => {
          if (err) return rej(new Error((stderr || err.message || '').toString().trim() || 'Falha no spool do Windows.'));
          return res();
        },
      );
    });
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Lista impressoras do Windows (para ajudar a encontrar o nome de compartilhamento).
function listPrinters() {
  return new Promise((res) => {
    if (process.platform !== 'win32') return res([]);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-Printer | Select-Object Name,ShareName,Shared | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return res([]);
        try {
          const parsed = JSON.parse(String(stdout).replace(/^﻿/, '').trim());
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          res(arr.map((p) => ({
            name: String(p.Name || ''),
            shareName: String(p.ShareName || ''),
            shared: Boolean(p.Shared),
          })).filter((p) => p.name));
        } catch {
          res([]);
        }
      },
    );
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  // Private Network Access: permite que uma página HTTPS pública chame o loopback.
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, agent: 'orquestra-print', version: 1, platform: process.platform });
    }
    if (req.method === 'GET' && url.pathname === '/printers') {
      return json(res, 200, { ok: true, printers: await listPrinters() });
    }
    if (req.method === 'POST' && url.pathname === '/print') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const zpl = body.zpl;
      const printer = String(body.printer || '').trim();
      const host = String(body.host || 'localhost').trim() || 'localhost';
      if (!zpl) return json(res, 400, { ok: false, error: 'ZPL ausente.' });
      if (!printer) return json(res, 400, { ok: false, error: 'Nome de compartilhamento ausente.' });
      await printRaw(zpl, printer, host);
      return json(res, 200, { ok: true, printer });
    }
    return json(res, 404, { ok: false, error: 'Rota não encontrada.' });
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Orquestra — Agente de Impressão ouvindo em http://127.0.0.1:${PORT}`);
  console.log('Deixe esta janela aberta. Para fechar o agente, feche esta janela.');
});
