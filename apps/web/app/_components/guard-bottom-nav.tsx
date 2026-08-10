'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

type ItemGuardia =
  | { id: string; label: string; icon: IconoGuardia; active: boolean; onSelect: () => void; disabled?: boolean }
  | { id: string; label: string; icon: IconoGuardia; active: boolean; href: string };

type IconoGuardia = 'turno' | 'puntos' | 'novedad' | 'resumen' | 'sesiones';

export function GuardBottomNav({ items }: { items: readonly ItemGuardia[] }) {
  const router = useRouter();
  return (
    <nav className="guardia-nav-inferior" aria-label="Navegación del turno">
      <div className="guardia-nav-superficie">
        {items.map((item) => {
          const contenido = <Contenido icon={item.icon} label={item.label} />;
          if ('href' in item) {
            return (
              <button
                aria-current={item.active ? 'page' : undefined}
                className={item.active ? 'guardia-nav-item activo' : 'guardia-nav-item'}
                key={item.id}
                onClick={() => {
                  router.push(item.href, { scroll: true });
                  window.scrollTo({ top: 0, behavior: 'instant' });
                }}
                type="button"
              >
                {contenido}
              </button>
            );
          }
          return (
            <button
              aria-current={item.active ? 'page' : undefined}
              className={item.active ? 'guardia-nav-item activo' : 'guardia-nav-item'}
              disabled={item.disabled}
              key={item.id}
              onClick={item.onSelect}
              type="button"
            >
              {contenido}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function Contenido({ icon, label }: { icon: IconoGuardia; label: string }): ReactNode {
  return (
    <>
      <span className="guardia-nav-icono" aria-hidden="true"><Icono name={icon} /></span>
      <span>{label}</span>
    </>
  );
}

function Icono({ name }: { name: IconoGuardia }) {
  if (name === 'turno') {
    return <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>;
  }
  if (name === 'puntos') {
    return <svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><path d="M7.5 7.5c3 2.5 6 1.5 7.5 4s-.5 4-1.5 4.5" /></svg>;
  }
  if (name === 'novedad') {
    return <svg viewBox="0 0 24 24"><path d="M6 5.5h12a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-6l-4.5 3v-3H6A1.5 1.5 0 0 1 4.5 15V7A1.5 1.5 0 0 1 6 5.5Z" /><path d="M8 9h8M8 12.5h5" /></svg>;
  }
  if (name === 'sesiones') {
    return <svg viewBox="0 0 24 24"><rect x="6.5" y="3.5" width="11" height="17" rx="2" /><path d="M10 17.5h4" /></svg>;
  }
  return <svg viewBox="0 0 24 24"><path d="M7 4.5h10v15H7z" /><path d="M9.5 8h5M9.5 11.5h5M9.5 15h3" /></svg>;
}
