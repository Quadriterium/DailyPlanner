import { useEffect, useRef, type ReactNode } from 'react';
import { X, Sprout } from 'lucide-react';

export function Botanical({ className = '' }: { className?: string }) {
  return <svg className={`botanical ${className}`} viewBox="0 0 220 230" fill="none" aria-hidden="true">
    <path d="M37 211C81 168 126 116 150 29M76 168C65 118 49 97 25 77M103 132C143 132 174 114 193 91M132 78C110 60 97 42 98 18" stroke="currentColor" strokeWidth="1.5" />
    <g fill="currentColor">
      <path d="M55 191C18 184 7 162 12 141C42 143 59 163 55 191Z" />
      <path d="M73 174C102 173 121 157 124 136C94 136 76 150 73 174Z" />
      <path d="M75 162C45 150 36 129 44 109C67 118 78 137 75 162Z" opacity=".8" />
      <path d="M94 144C124 146 144 133 151 113C126 107 102 121 94 144Z" opacity=".6" />
      <path d="M112 115C86 109 72 88 78 66C100 73 113 91 112 115Z" />
      <path d="M131 85C157 86 177 68 180 47C154 47 136 61 131 85Z" opacity=".7" />
      <path d="M145 49C132 28 136 8 152 1C163 20 159 38 145 49Z" />
      <path d="M57 123C30 124 15 105 13 89C36 86 54 103 57 123Z" opacity=".55" />
      <path d="M166 118C188 127 211 115 217 98C194 90 177 102 166 118Z" />
      <path d="M121 66C95 62 83 45 87 28C108 32 121 45 121 66Z" opacity=".65" />
    </g>
    <g fill="#b87955"><circle cx="185" cy="152" r="3" /><circle cx="180" cy="166" r="2" /><circle cx="27" cy="49" r="2.5" /></g>
  </svg>;
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty-state"><Sprout size={28} strokeWidth={1.3} /><h3>{title}</h3><p>{children}</p></div>;
}

export function Modal({ title, children, onClose, wide = false }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const close = () => onCloseRef.current();
    element.addEventListener('close', close);
    return () => {
      element.removeEventListener('close', close);
      element.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);
  return <dialog ref={dialog} className={`modal ${wide ? 'wide' : ''}`} aria-label={title}
    onClick={event => {
      if (event.target !== dialog.current) return;
      const bounds = dialog.current.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="Fermer" onClick={onClose}><X size={20} /></button></div>
    {children}
  </dialog>;
}
