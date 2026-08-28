import "@wterm/dom/css";
import "./styles/app.scss";
import { mount } from "svelte";
import App from "./ui/pages/App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("Gradivus renderer mount target is missing");
mount(App, { target });
