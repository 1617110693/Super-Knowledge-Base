import { Routes, Route } from "react-router-dom";
import { I18nProvider } from "./i18n/I18nProvider";
import { AppLayout } from "./components/layout/AppLayout";
import { KBDashboard } from "./components/knowledge-base/KBDashboard";
import { KBSettings } from "./components/knowledge-base/KBSettings";
import { DocumentPreview } from "./components/documents/DocumentPreview";
import { SearchInterface } from "./components/search/SearchInterface";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { ChatPage } from "./components/chat/ChatPage";

function App() {
  return (
    <I18nProvider>
      <Routes>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<KBDashboard />} />
          <Route path="kb/:kbId" element={<KBSettings />} />
          <Route path="kb/:kbId/documents/:docId" element={<DocumentPreview />} />
          <Route path="kb/:kbId/search" element={<SearchInterface />} />
          <Route path="chat/:convId" element={<ChatPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="settings" element={<SettingsPanel />} />
        </Route>
      </Routes>
    </I18nProvider>
  );
}

export default App;
