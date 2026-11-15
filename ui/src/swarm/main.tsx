import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SwarmApp } from "./SwarmApp";
import "../styles.css";
import "./swarm.css";
createRoot(document.getElementById("root")!).render(<StrictMode><SwarmApp /></StrictMode>);
