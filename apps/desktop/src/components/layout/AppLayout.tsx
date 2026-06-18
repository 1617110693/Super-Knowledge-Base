import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useSettingsStore } from "../../stores/useSettingsStore";

export function AppLayout() {
  const { loadSettings, checkPythonStatus, startPython, pythonRunning } =
    useSettingsStore();

  useEffect(() => {
    loadSettings();
    checkPythonStatus().then(() => {
      if (!pythonRunning) {
        startPython();
      }
    });
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-auto bg-muted/30">
        <Outlet />
      </main>
    </div>
  );
}
