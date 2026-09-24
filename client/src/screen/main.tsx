import { createRoot } from "react-dom/client";
import "../theme.css";
import { Intro } from "../ui/Intro";
import { App } from "./App";

// L'animation d'entrée se joue par-dessus l'interface, qui se charge pendant ce temps.
createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <Intro />
  </>,
);
