import { createRoot } from "react-dom/client";
import { enablePwa } from "../lib/pwa";
import "../theme.css";
import { Intro } from "../ui/Intro";
import { App } from "./App";

// Seule la page apprenant s'installe : le formateur et l'administration ont l'application
// de bureau, et l'écran de salle vit sur un PC de projection.
enablePwa();

// L'animation d'entrée se joue par-dessus l'interface, qui se charge pendant ce temps.
createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <Intro />
  </>,
);
