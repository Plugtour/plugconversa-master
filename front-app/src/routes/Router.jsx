/* caminho: front-app/src/routes/Router.jsx */
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Inbox from "../pages/inbox/Inbox.jsx";

function Placeholder({ title }) {
  return (
    <div style={{ padding: 40 }}>
      <h1>{title}</h1>
      <p>Estrutura base carregada.</p>
    </div>
  );
}

function Router() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Placeholder title="Dashboard" />} />
        <Route path="/inbox" element={<Inbox />} />
      </Routes>
    </BrowserRouter>
  );
}

export default Router;
/* caminho: front-app/src/routes/Router.jsx */