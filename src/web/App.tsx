import { Dashboard } from "./pages/Dashboard";
import { ServiceDetail } from "./pages/ServiceDetail";
import { ServiceForm } from "./pages/ServiceForm";
import { Settings } from "./pages/Settings";
import { useRoute } from "./router";

export function App() {
  const route = useRoute();
  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">
          UsageManagement
        </a>
        <span className="muted small">無料枠・利用量ダッシュボード</span>
        <nav className="topnav">
          <a href="#/" aria-current={route.name === "dashboard" ? "page" : undefined}>
            ダッシュボード
          </a>
          <a href="#/settings" aria-current={route.name === "settings" ? "page" : undefined}>
            設定
          </a>
        </nav>
      </header>
      <main className="container">
        {route.name === "dashboard" && <Dashboard />}
        {route.name === "service-new" && <ServiceForm />}
        {route.name === "service" && <ServiceDetail key={route.id} id={route.id} />}
        {route.name === "service-edit" && <ServiceForm key={route.id} id={route.id} />}
        {route.name === "settings" && <Settings />}
        {route.name === "not-found" && (
          <p>
            ページが見つかりません。<a href="#/">ダッシュボードへ</a>
          </p>
        )}
      </main>
    </>
  );
}
