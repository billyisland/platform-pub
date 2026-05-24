import { create } from "zustand";

interface ReaderState {
  isOpen: boolean;
  url: string | null;
  title: string | null;
  siteName: string | null;
  open: (url: string, title?: string, siteName?: string) => void;
  close: () => void;
}

export const useReader = create<ReaderState>((set) => ({
  isOpen: false,
  url: null,
  title: null,
  siteName: null,
  open: (url, title, siteName) =>
    set({
      isOpen: true,
      url,
      title: title ?? null,
      siteName: siteName ?? null,
    }),
  close: () => set({ isOpen: false, url: null, title: null, siteName: null }),
}));
