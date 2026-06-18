import { Routes, Route } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { KBDashboard } from "./components/knowledge-base/KBDashboard";
import { KBSettings } from "./components/knowledge-base/KBSettings";
import { DocumentManager } from "./components/documents/DocumentManager";
import { DocumentPreview } from "./components/documents/DocumentPreview";
import { SearchInterface } from "./components/search/SearchInterface";
import { ChatInterface } from "./components/chat/ChatInterface";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { ImportExport } from "./components/knowledge-base/ImportExport";

function App() {
  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route index element={<KBDashboard />} />
        <Route path="kb/:kbId" element={<KBSettings />} />
        <Route path="kb/:kbId/documents" element={<DocumentManager />} />
        <Route path="kb/:kbId/documents/:docId" element={<DocumentPreview />} />
        <Route path="kb/:kbId/search" element={<SearchInterface />} />
        <Route path="kb/:kbId/chat" element={<ChatInterface />} />
        <Route path="settings" element={<SettingsPanel />} />
        <Route path="import-export" element={<ImportExport />} />
      </Route>
    </Routes>
  );
}

export default App;
