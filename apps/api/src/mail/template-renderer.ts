import type { MailTemplate, MailTemplateVariables } from './mail-provider';

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.-]*)\s*\}\}/g;

export function renderTemplate(
  template: MailTemplate,
  variables: MailTemplateVariables,
): MailTemplate {
  return {
    subject: interpolate(template.subject, variables, sanitizeHeader),
    text: interpolate(template.text, variables, String),
    ...(template.html === undefined
      ? {}
      : { html: interpolate(template.html, variables, escapeHtml) }),
  };
}

function interpolate(
  source: string,
  variables: MailTemplateVariables,
  encode: (value: unknown) => string,
): string {
  return source.replace(PLACEHOLDER, (_match: string, key: string) => {
    const value = variables[key];
    if (value === undefined || value === null) {
      throw new Error(`Falta la variable requerida por la plantilla: ${key}`);
    }
    return encode(value);
  });
}

function sanitizeHeader(value: unknown): string {
  return String(value).replace(/[\r\n]+/g, ' ');
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
