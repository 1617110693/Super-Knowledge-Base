import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { TitleBar } from "./TitleBar";
import { Sidebar } from "./Sidebar";
import { useSettingsStore } from "../../stores/useSettingsStore";

export function AppLayout() {
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const checkPythonStatus = useSettingsStore((s) => s.checkPythonStatus);
  const startPython = useSettingsStore((s) => s.startPython);

  useEffect(() => {
    loadSettings();
    checkPythonStatus().then((running) => {
      if (!running) {
        startPython();
      }
    });
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden rounded-xl">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto bg-muted/30" style={{ overflowAnchor: "none" }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
