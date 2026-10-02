"use client";

import { create } from "zustand";

/** English first; Hindi and Marathi strings for the main surfaces. Add keys here, never inline. */
const en = {
  "nav.bookings": "My bookings",
  "nav.approvals": "Approvals",
  "nav.conflicts": "Conflict center",
  "nav.admin": "Admin",
  "nav.swaps": "Swaps",
  "nav.swipe": "Swipe",
  "chaos.button": "⚡ Simulate Chaos",
  "chaos.running": "Simulating…",
  "toolbar.level": "Level",
  "toolbar.now": "Now",
  "toolbar.today": "Today",
  "card.available": "This space is available!",
  "card.book": "Book for",
  "card.request": "Request for",
  "card.otherTimes": "Other available times",
  "card.timeline": "Today's timeline",
  "card.scheduled": "Scheduled bookings",
  "card.waitlist": "Join waitlist for",
  "legend.title": "Live state",
  "state.free": "Available",
  "state.booked": "Booked",
  "state.pending": "Pending approval",
  "state.ghost": "Booked but empty",
  "state.inuse": "Checked in · in use",
  "state.blackout": "Blackout",
  "state.held": "Soft-held (confirming)",
  "state.squatter": "Free but occupied",
  "assistant.open": "Ask XIE Spaces",
};
export type Key = keyof typeof en;

const hi: Partial<Record<Key, string>> = {
  "nav.bookings": "मेरी बुकिंग",
  "nav.approvals": "अनुमोदन",
  "nav.conflicts": "विवाद केंद्र",
  "nav.admin": "प्रशासन",
  "nav.swaps": "अदला-बदली",
  "nav.swipe": "स्वाइप",
  "chaos.button": "⚡ अराजकता अनुकरण",
  "chaos.running": "अनुकरण जारी…",
  "toolbar.level": "मंज़िल",
  "toolbar.now": "अभी",
  "toolbar.today": "आज",
  "card.available": "यह स्थान उपलब्ध है!",
  "card.book": "बुक करें",
  "card.request": "अनुरोध करें",
  "card.otherTimes": "अन्य उपलब्ध समय",
  "card.timeline": "आज की समय-रेखा",
  "card.scheduled": "निर्धारित बुकिंग",
  "card.waitlist": "प्रतीक्षा सूची में जुड़ें",
  "legend.title": "लाइव स्थिति",
  "state.free": "उपलब्ध",
  "state.booked": "बुक",
  "state.pending": "अनुमोदन लंबित",
  "state.ghost": "बुक पर खाली",
  "state.inuse": "उपयोग में",
  "state.blackout": "प्रतिबंधित",
  "state.held": "अस्थायी रोक",
  "state.squatter": "खाली पर भरा हुआ",
  "assistant.open": "XIE Spaces से पूछें",
};

const mr: Partial<Record<Key, string>> = {
  "nav.bookings": "माझी बुकिंग",
  "nav.approvals": "मंजुरी",
  "nav.conflicts": "संघर्ष केंद्र",
  "nav.admin": "प्रशासन",
  "nav.swaps": "अदलाबदल",
  "nav.swipe": "स्वाइप",
  "chaos.button": "⚡ गोंधळ अनुकरण",
  "chaos.running": "अनुकरण सुरू…",
  "toolbar.level": "मजला",
  "toolbar.now": "आता",
  "toolbar.today": "आज",
  "card.available": "ही जागा उपलब्ध आहे!",
  "card.book": "बुक करा",
  "card.request": "विनंती करा",
  "card.otherTimes": "इतर उपलब्ध वेळा",
  "card.timeline": "आजची वेळरेषा",
  "card.scheduled": "नियोजित बुकिंग",
  "card.waitlist": "प्रतीक्षा यादीत सामील व्हा",
  "legend.title": "थेट स्थिती",
  "state.free": "उपलब्ध",
  "state.booked": "बुक",
  "state.pending": "मंजुरी प्रलंबित",
  "state.ghost": "बुक पण रिकामी",
  "state.inuse": "वापरात",
  "state.blackout": "प्रतिबंधित",
  "state.held": "तात्पुरती रोख",
  "state.squatter": "रिकामी पण व्यापलेली",
  "assistant.open": "XIE Spaces ला विचारा",
};

export const LANGS = { en: "English", hi: "हिन्दी", mr: "मराठी" } as const;
export type Lang = keyof typeof LANGS;
const DICT: Record<Lang, Partial<Record<Key, string>>> = { en, hi, mr };

export const useLang = create<{ lang: Lang; setLang: (l: Lang) => void }>((set) => ({
  lang: "en",
  setLang: (lang) => {
    try {
      localStorage.setItem("xie-lang", lang);
    } catch {}
    document.documentElement.lang = lang;
    set({ lang });
  },
}));

export function useT() {
  const lang = useLang((s) => s.lang);
  return (k: Key) => DICT[lang][k] ?? en[k];
}

export function restoreLang() {
  try {
    const l = localStorage.getItem("xie-lang") as Lang | null;
    if (l && l in LANGS) useLang.getState().setLang(l);
  } catch {}
}
