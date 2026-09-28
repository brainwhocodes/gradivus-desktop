import "../src/styles/hosted.scss";
import { mount } from "svelte";
import WorkspaceFixture from "./WorkspaceFixture.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("Workspace fixture mount target is missing");

mount(WorkspaceFixture, { target });
