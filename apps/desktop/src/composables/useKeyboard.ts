import { onMounted, onUnmounted } from "vue";

export type ShortcutHandler = (e: KeyboardEvent) => void;

export interface Shortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: ShortcutHandler;
}

export function useKeyboard(shortcuts: Shortcut[]) {
  function onKeydown(e: KeyboardEvent) {
    for (const s of shortcuts) {
      // For single-letter keys, match e.code (e.g. "KeyD") for keyboard layout independence
      // For special keys (PageDown, Home, End, etc.), match e.key
      const isLetter = s.key.length === 1 && /[a-z]/i.test(s.key);
      const keyMatch = isLetter
        ? e.code === `Key${s.key.toUpperCase()}`
        : e.key.toLowerCase() === s.key.toLowerCase();
      const ctrlMatch = s.ctrl ? e.ctrlKey || e.metaKey : !e.ctrlKey && !e.metaKey;
      const shiftMatch = s.shift ? e.shiftKey : !e.shiftKey;
      const altMatch = s.alt ? e.altKey : !e.altKey;

      if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
        e.preventDefault();
        e.stopPropagation();
        s.handler(e);
        return;
      }
    }
  }

  // Use capture phase to intercept keys before WebView2 accelerator handling
  onMounted(() => window.addEventListener("keydown", onKeydown, true));
  onUnmounted(() => window.removeEventListener("keydown", onKeydown, true));
}
