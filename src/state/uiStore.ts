import { create } from "zustand";
import { persist } from "zustand/middleware";

export type NavItem = "services" | "install" | "ports" | "activity" | "settings";
export type Language = "en" | "zh";
export type RefreshMode = "energySaver" | "standard" | "realtime";

interface UiState {
  nav: NavItem;
  language: Language;
  refreshMode: RefreshMode;
  reduceRefreshInBackground: boolean;
  selectedServiceId: string | null;
  statusFilter: "all" | "running" | "stopped" | "error" | "unknown";
  search: string;
  logQuery: string;
  setNav: (nav: NavItem) => void;
  setLanguage: (language: Language) => void;
  setRefreshMode: (refreshMode: RefreshMode) => void;
  setReduceRefreshInBackground: (enabled: boolean) => void;
  setSelectedServiceId: (serviceId: string | null) => void;
  setStatusFilter: (status: UiState["statusFilter"]) => void;
  setSearch: (search: string) => void;
  setLogQuery: (query: string) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      nav: "services",
      language: "en",
      refreshMode: "standard",
      reduceRefreshInBackground: true,
      selectedServiceId: null,
      statusFilter: "all",
      search: "",
      logQuery: "",
      setNav: (nav) => set({ nav }),
      setLanguage: (language) => set({ language }),
      setRefreshMode: (refreshMode) => set({ refreshMode }),
      setReduceRefreshInBackground: (reduceRefreshInBackground) =>
        set({ reduceRefreshInBackground }),
      setSelectedServiceId: (selectedServiceId) => set({ selectedServiceId }),
      setStatusFilter: (statusFilter) => set({ statusFilter }),
      setSearch: (search) => set({ search }),
      setLogQuery: (logQuery) => set({ logQuery })
    }),
    {
      name: "locers-ui",
      partialize: (state) => ({
        language: state.language,
        refreshMode: state.refreshMode,
        reduceRefreshInBackground: state.reduceRefreshInBackground
      })
    }
  )
);
