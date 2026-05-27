import pool from '../config/database.js';
import { attachToJiraIssue } from '../services/jiraService.js';

// Etapa 5 — sincroniza PDF de NF com o card do Jira correspondente.
// Estratégia:
//   1) O frontend chama POST /api/jira/attach-nf logo após o upload bem
//      sucedido em /invoices/:number/documents (backend CarbonProduction).
//   2) Resolvemos o issueKey procurando a OS (orderNumber) no resumo dos
//      cards já cacheados em maestro.jira_cards — preenchido pelo cron Jira.
//   3) Anexamos via jiraService.attachToJiraIssue (multipart) e registramos
//      em maestro.jira_nf_attachments para mostrar o badge "Sincronizado"
//      sem precisar consultar o Jira a cada renderização.
// Degradação graciosa: falha no Jira não derruba o upload local, apenas
// grava status='FAILED' com error_message.

function buildOrderRegex(orderNumber) {
  // Casa palavra inteira no resumo (\m e \M são word boundaries no POSIX ERE).
  return `\\m${orderNumber}\\M`;
}

async function resolveIssueKey(orderNumber) {
  if (!orderNumber) return null;
  // Procura o card mais recente cujo resumo contenha o número da OS como
  // palavra inteira. last_updated_at desempata casos com múltiplos cards.
  const res = await pool.query(
    `SELECT key
       FROM maestro.jira_cards
      WHERE resumo ~ $1
      ORDER BY last_updated_at DESC NULLS LAST
      LIMIT 1`,
    [buildOrderRegex(orderNumber)],
  );
  return res.rows[0]?.key || null;
}

// POST /api/jira/attach-nf
// multipart: file (PDF) + fields invoiceNumber, orderNumber
export const attachNf = async (req, res) => {
  const invoiceNumber = String(req.body?.invoiceNumber || '').trim();
  const orderNumber   = String(req.body?.orderNumber   || '').trim();
  const file = req.file;
  const userId = req.user?.id || null;

  if (!invoiceNumber) {
    return res.status(400).json({ success: false, message: 'invoiceNumber é obrigatório.' });
  }
  if (!file) {
    return res.status(400).json({ success: false, message: 'file é obrigatório (PDF da NF).' });
  }
  if (file.mimetype && file.mimetype !== 'application/pdf') {
    return res.status(400).json({ success: false, message: 'Apenas PDFs são aceitos.' });
  }

  const filename = file.originalname || `NF-${invoiceNumber}.pdf`;
  let issueKey = null;
  let jiraAttachmentId = null;
  let status = 'SUCCESS';
  let errorMessage = null;

  try {
    issueKey = await resolveIssueKey(orderNumber);
    if (!issueKey) {
      status = 'FAILED';
      errorMessage = `Card Jira não encontrado para OS ${orderNumber}.`;
    } else {
      const attachmentIds = await attachToJiraIssue(userId, issueKey, filename, file.buffer);
      jiraAttachmentId = Array.isArray(attachmentIds) ? attachmentIds[0] || null : null;
    }
  } catch (err) {
    status = 'FAILED';
    errorMessage = err?.response?.data?.errorMessages?.join('; ')
                || err?.response?.data?.message
                || err?.message
                || 'Falha ao anexar no Jira';
  }

  try {
    await pool.query(
      `INSERT INTO maestro.jira_nf_attachments
         (invoice_number, order_number, jira_issue_key, jira_attachment_id, filename, status, error_message, attached_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [invoiceNumber, orderNumber || null, issueKey, jiraAttachmentId, filename, status, errorMessage, userId],
    );
  } catch (logErr) {
    // Não derruba a resposta — apenas loga no console.
    console.error('❌ Erro ao registrar jira_nf_attachments:', logErr);
  }

  if (status === 'FAILED') {
    return res.status(200).json({
      success: false,
      synced: false,
      message: errorMessage,
      jiraIssueKey: issueKey,
    });
  }
  return res.status(200).json({
    success: true,
    synced: true,
    jiraIssueKey: issueKey,
    jiraAttachmentId,
    filename,
  });
};

// GET /api/jira/attach-nf/status?invoiceNumber=...
export const attachNfStatus = async (req, res) => {
  try {
    const invoiceNumber = String(req.query?.invoiceNumber || '').trim();
    if (!invoiceNumber) {
      return res.status(400).json({ success: false, message: 'invoiceNumber é obrigatório.' });
    }
    const result = await pool.query(
      `SELECT id, invoice_number, order_number, jira_issue_key, jira_attachment_id,
              filename, status, error_message, attached_by, attached_at
         FROM maestro.jira_nf_attachments
        WHERE invoice_number = $1
        ORDER BY attached_at DESC
        LIMIT 5`,
      [invoiceNumber],
    );
    const latest = result.rows[0] || null;
    return res.status(200).json({
      success: true,
      data: {
        latest,
        history: result.rows,
        synced: !!latest && latest.status === 'SUCCESS',
      },
    });
  } catch (error) {
    console.error('❌ Erro ao consultar attach-nf status:', error);
    return res.status(500).json({ success: false, message: `Erro: ${error.message}` });
  }
};
