import "./styles/hosted.scss";
import { mount } from "svelte";
import HostedApp from "./HostedApp.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("Gradivus Chat mount target is missing");

mount(HostedApp, { target });
