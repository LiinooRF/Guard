type FormValues = Pick<FormData, 'get'>;

/**
 * Lee lo que el navegador muestra al enviar el formulario.
 *
 * Los gestores de contraseñas y el autocompletado pueden rellenar un input sin
 * disparar `onChange`; en ese caso el estado de React queda vacío aunque el
 * usuario vea sus credenciales. FormData representa el valor real enviado.
 */
export function leerCredenciales(form: FormValues) {
  const identity = form.get('identity');
  const password = form.get('password');
  const tenantId = form.get('tenantId');

  return {
    identity: typeof identity === 'string' ? identity.trim() : '',
    password: typeof password === 'string' ? password : '',
    tenantId: typeof tenantId === 'string' ? tenantId : '',
  };
}

