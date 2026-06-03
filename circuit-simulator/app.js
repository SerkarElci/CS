(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const COMPONENT_SPECS = {
    battery: {
      label: "Battery",
      width: 132,
      height: 88,
      terminals: [
        { id: "neg", label: "-", x: 10, y: 44 },
        { id: "pos", label: "+", x: 122, y: 44 }
      ]
    },
    bulb: {
      label: "Light bulb",
      width: 118,
      height: 124,
      terminals: [
        { id: "a", label: "", x: 34, y: 110 },
        { id: "b", label: "", x: 84, y: 110 }
      ]
    },
    switch: {
      label: "Switch",
      width: 132,
      height: 82,
      terminals: [
        { id: "a", label: "", x: 10, y: 44 },
        { id: "b", label: "", x: 122, y: 44 }
      ]
    }
  };

  const state = {
    components: [],
    wires: [],
    selected: null,
    poweredBulbs: new Set(),
    hasShortCircuit: false
  };

  const elements = {};
  let nextId = 1;
  let interaction = null;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    elements.board = document.getElementById("board");
    elements.wireLayer = document.getElementById("wireLayer");
    elements.wireOverlayLayer = document.getElementById("wireOverlayLayer");
    elements.componentLayer = document.getElementById("componentLayer");
    elements.powerStatus = document.getElementById("powerStatus");
    elements.selectionStatus = document.getElementById("selectionStatus");
    elements.canvasSummary = document.getElementById("canvasSummary");
    elements.deleteBtn = document.getElementById("deleteBtn");
    elements.clearBtn = document.getElementById("clearBtn");

    document.querySelectorAll(".tool-card").forEach((tool) => {
      tool.addEventListener("pointerdown", startPaletteDrag);
    });

    elements.deleteBtn.addEventListener("click", deleteSelected);
    elements.clearBtn.addEventListener("click", clearBoard);
    elements.board.addEventListener("pointerdown", handleBoardPointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", render);

    render();
  }

  function createId(prefix) {
    const id = `${prefix}-${nextId}`;
    nextId += 1;
    return id;
  }

  function startPaletteDrag(event) {
    if (event.button !== 0) {
      return;
    }

    const type = event.currentTarget.dataset.type;
    const spec = COMPONENT_SPECS[type];
    if (!spec) {
      return;
    }

    event.preventDefault();
    const ghost = createGhostComponent(type);
    document.body.appendChild(ghost);

    interaction = {
      mode: "palette",
      pointerId: event.pointerId,
      type,
      ghost
    };

    moveGhost(event);
    bindPointerLifecycle();
  }

  function createGhostComponent(type) {
    const spec = COMPONENT_SPECS[type];
    const ghost = document.createElement("div");
    ghost.className = `component component-${type} drag-ghost`;
    ghost.style.setProperty("--component-width", `${spec.width}px`);
    ghost.style.setProperty("--component-height", `${spec.height}px`);
    ghost.innerHTML = componentMarkup({ type, isClosed: false });
    return ghost;
  }

  function startComponentDrag(event, componentId) {
    if (event.button !== 0 || event.target.closest(".terminal")) {
      return;
    }

    const component = getComponent(componentId);
    if (!component) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    state.selected = { type: "component", id: componentId };

    const point = clientToBoard(event.clientX, event.clientY);
    interaction = {
      mode: "component",
      pointerId: event.pointerId,
      componentId,
      offsetX: point.x - component.x,
      offsetY: point.y - component.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false
    };

    bindPointerLifecycle();
    render();
  }

  function startWireDrag(event, componentId, terminalId) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const start = getTerminalPosition(componentId, terminalId);
    if (!start) {
      return;
    }

    interaction = {
      mode: "wire",
      pointerId: event.pointerId,
      fromComponentId: componentId,
      fromTerminalId: terminalId,
      end: start
    };

    state.selected = null;
    bindPointerLifecycle();
    render();
  }

  function bindPointerLifecycle() {
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", cancelInteraction);
  }

  function unbindPointerLifecycle() {
    document.removeEventListener("pointermove", handlePointerMove);
    document.removeEventListener("pointerup", handlePointerUp);
    document.removeEventListener("pointercancel", cancelInteraction);
  }

  function handlePointerMove(event) {
    if (!interaction || event.pointerId !== interaction.pointerId) {
      return;
    }

    event.preventDefault();

    if (interaction.mode === "palette") {
      moveGhost(event);
      return;
    }

    if (interaction.mode === "component") {
      const component = getComponent(interaction.componentId);
      if (!component) {
        cancelInteraction();
        return;
      }

      const distance = Math.hypot(
        event.clientX - interaction.startClientX,
        event.clientY - interaction.startClientY
      );
      interaction.moved = interaction.moved || distance > 4;

      const point = clientToBoard(event.clientX, event.clientY);
      const nextPosition = clampComponentPosition(
        component.type,
        point.x - interaction.offsetX,
        point.y - interaction.offsetY
      );

      component.x = nextPosition.x;
      component.y = nextPosition.y;
      render();
      return;
    }

    if (interaction.mode === "wire") {
      interaction.end = clientToBoard(event.clientX, event.clientY);
      render();
    }
  }

  function handlePointerUp(event) {
    if (!interaction || event.pointerId !== interaction.pointerId) {
      return;
    }

    event.preventDefault();

    if (interaction.mode === "palette") {
      if (isInsideBoard(event.clientX, event.clientY)) {
        const point = clientToBoard(event.clientX, event.clientY);
        const spec = COMPONENT_SPECS[interaction.type];
        addComponent(
          interaction.type,
          point.x - spec.width / 2,
          point.y - spec.height / 2
        );
      }
      finishInteraction(false);
      render();
      return;
    }

    if (interaction.mode === "component") {
      const component = getComponent(interaction.componentId);
      if (component && component.type === "switch" && !interaction.moved) {
        component.isClosed = !component.isClosed;
      }
      finishInteraction(false);
      render();
      return;
    }

    if (interaction.mode === "wire") {
      const target = getTerminalUnderPointer(event.clientX, event.clientY);
      const source = {
        componentId: interaction.fromComponentId,
        terminalId: interaction.fromTerminalId
      };

      if (canConnect(source, target)) {
        addWire(source, target);
      }

      finishInteraction(false);
      render();
    }
  }

  function cancelInteraction() {
    finishInteraction(true);
  }

  function finishInteraction(shouldRender) {
    if (interaction && interaction.ghost) {
      interaction.ghost.remove();
    }
    interaction = null;
    unbindPointerLifecycle();
    if (shouldRender) {
      render();
    }
  }

  function moveGhost(event) {
    if (!interaction || !interaction.ghost) {
      return;
    }

    interaction.ghost.style.left = `${event.clientX}px`;
    interaction.ghost.style.top = `${event.clientY}px`;
  }

  function addComponent(type, x, y) {
    const position = clampComponentPosition(type, x, y);
    const component = {
      id: createId(type),
      type,
      x: position.x,
      y: position.y
    };

    if (type === "switch") {
      component.isClosed = false;
    }

    state.components.push(component);
    state.selected = { type: "component", id: component.id };
  }

  function addWire(source, target) {
    const wire = {
      id: createId("wire"),
      fromComponentId: source.componentId,
      fromTerminalId: source.terminalId,
      toComponentId: target.componentId,
      toTerminalId: target.terminalId
    };

    state.wires.push(wire);
    state.selected = { type: "wire", id: wire.id };
  }

  function canConnect(source, target) {
    if (!source || !target) {
      return false;
    }

    if (
      source.componentId === target.componentId &&
      source.terminalId === target.terminalId
    ) {
      return false;
    }

    if (source.componentId === target.componentId) {
      return false;
    }

    return !state.wires.some((wire) =>
      endpointsMatch(wire, source, target)
    );
  }

  function endpointsMatch(wire, source, target) {
    const firstMatches =
      wire.fromComponentId === source.componentId &&
      wire.fromTerminalId === source.terminalId &&
      wire.toComponentId === target.componentId &&
      wire.toTerminalId === target.terminalId;
    const secondMatches =
      wire.fromComponentId === target.componentId &&
      wire.fromTerminalId === target.terminalId &&
      wire.toComponentId === source.componentId &&
      wire.toTerminalId === source.terminalId;
    return firstMatches || secondMatches;
  }

  function deleteSelected() {
    if (!state.selected) {
      return;
    }

    if (state.selected.type === "component") {
      const componentId = state.selected.id;
      state.components = state.components.filter((component) => component.id !== componentId);
      state.wires = state.wires.filter(
        (wire) =>
          wire.fromComponentId !== componentId && wire.toComponentId !== componentId
      );
    }

    if (state.selected.type === "wire") {
      state.wires = state.wires.filter((wire) => wire.id !== state.selected.id);
    }

    state.selected = null;
    render();
  }

  function clearBoard() {
    state.components = [];
    state.wires = [];
    state.selected = null;
    state.poweredBulbs = new Set();
    state.hasShortCircuit = false;
    nextId = 1;
    render();
  }

  function handleKeyDown(event) {
    if ((event.key === "Delete" || event.key === "Backspace") && state.selected) {
      event.preventDefault();
      deleteSelected();
    }

    if (event.key === "Escape") {
      if (interaction) {
        cancelInteraction();
      } else if (state.selected) {
        state.selected = null;
        render();
      }
    }
  }

  function handleBoardPointerDown(event) {
    if (
      event.target === elements.board ||
      event.target === elements.wireLayer ||
      event.target === elements.componentLayer
    ) {
      state.selected = null;
      render();
    }
  }

  function render() {
    syncWireLayerSize();
    const analysis = analyzeCircuit();
    state.poweredBulbs = analysis.poweredBulbs;
    state.hasShortCircuit = analysis.hasShortCircuit;
    renderWires();
    renderComponents();
    updateStatus();
  }

  function syncWireLayerSize() {
    const rect = elements.board.getBoundingClientRect();
    [elements.wireLayer, elements.wireOverlayLayer].forEach((layer) => {
      layer.setAttribute("width", rect.width);
      layer.setAttribute("height", rect.height);
      layer.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    });
  }

  function renderWires() {
    elements.wireLayer.innerHTML = "";
    elements.wireOverlayLayer.innerHTML = "";

    state.wires.forEach((wire) => {
      const from = getTerminalPosition(wire.fromComponentId, wire.fromTerminalId);
      const to = getTerminalPosition(wire.toComponentId, wire.toTerminalId);
      if (!from || !to) {
        return;
      }

      const pathData = cablePath(from, to);
      const hit = makePath(pathData, "wire-hit");
      const sleeve = makePath(pathData, "wire-sleeve");
      const visible = makePath(pathData, "wire-visible");
      const isSelected =
        state.selected &&
        state.selected.type === "wire" &&
        state.selected.id === wire.id;

      if (isSelected) {
        sleeve.classList.add("is-selected");
        visible.classList.add("is-selected");
      }

      hit.dataset.wireId = wire.id;
      hit.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.selected = { type: "wire", id: wire.id };
        render();
      });

      elements.wireLayer.appendChild(hit);
      elements.wireOverlayLayer.appendChild(sleeve);
      elements.wireOverlayLayer.appendChild(visible);
    });

    if (interaction && interaction.mode === "wire") {
      const from = getTerminalPosition(
        interaction.fromComponentId,
        interaction.fromTerminalId
      );
      if (from && interaction.end) {
        elements.wireOverlayLayer.appendChild(
          makePath(cablePath(from, interaction.end), "wire-preview")
        );
      }
    }
  }

  function renderComponents() {
    elements.componentLayer.innerHTML = "";

    state.components.forEach((component) => {
      const spec = COMPONENT_SPECS[component.type];
      const element = document.createElement("div");
      const isSelected =
        state.selected &&
        state.selected.type === "component" &&
        state.selected.id === component.id;
      const isPowered =
        component.type === "bulb" && state.poweredBulbs.has(component.id);

      element.className = [
        "component",
        `component-${component.type}`,
        component.isClosed ? "is-closed" : "",
        isSelected ? "is-selected" : "",
        isPowered ? "is-powered" : ""
      ]
        .filter(Boolean)
        .join(" ");

      element.dataset.componentId = component.id;
      element.style.left = `${component.x}px`;
      element.style.top = `${component.y}px`;
      element.style.setProperty("--component-width", `${spec.width}px`);
      element.style.setProperty("--component-height", `${spec.height}px`);
      element.setAttribute("role", "button");
      element.setAttribute("tabindex", "0");
      element.setAttribute("aria-label", `${spec.label} component`);
      element.innerHTML = componentMarkup(component);

      spec.terminals.forEach((terminal) => {
        const terminalElement = document.createElement("button");
        terminalElement.type = "button";
        terminalElement.className = "terminal";
        terminalElement.dataset.componentId = component.id;
        terminalElement.dataset.terminalId = terminal.id;
        terminalElement.style.left = `${terminal.x - 11}px`;
        terminalElement.style.top = `${terminal.y - 11}px`;
        terminalElement.textContent = terminal.label;
        terminalElement.setAttribute(
          "aria-label",
          `${spec.label} ${terminal.id} terminal`
        );
        terminalElement.addEventListener("pointerdown", (event) =>
          startWireDrag(event, component.id, terminal.id)
        );
        element.appendChild(terminalElement);
      });

      element.addEventListener("pointerdown", (event) =>
        startComponentDrag(event, component.id)
      );

      elements.componentLayer.appendChild(element);
    });
  }

  function componentMarkup(component) {
    if (component.type === "battery") {
      return `
        <div class="component-title">Battery</div>
        <div class="polarity negative">-</div>
        <div class="battery-art" aria-hidden="true">
          <span class="battery-cell short"></span>
          <span class="battery-cell tall"></span>
        </div>
        <div class="polarity positive">+</div>
      `;
    }

    if (component.type === "bulb") {
      return `
        <div class="component-title">Bulb</div>
        <div class="bulb-art" aria-hidden="true">
          <div class="bulb-glow"></div>
          <div class="bulb-glass"><span class="filament"></span></div>
          <div class="bulb-base"></div>
        </div>
      `;
    }

    if (component.type === "switch") {
      return `
        <div class="component-title">Switch</div>
        <div class="switch-state">${component.isClosed ? "Closed" : "Open"}</div>
        <div class="switch-art" aria-hidden="true">
          <span class="switch-post left"></span>
          <span class="switch-lever"></span>
          <span class="switch-post right"></span>
        </div>
      `;
    }

    return "";
  }

  function makePath(pathData, className) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", pathData);
    path.setAttribute("class", className);
    return path;
  }

  function cablePath(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    if (Math.abs(dx) < 36 && Math.abs(dy) > 36) {
      const offset = Math.max(46, Math.min(110, Math.abs(dy) * 0.38));
      const direction = dy >= 0 ? 1 : -1;
      return [
        `M ${round(from.x)} ${round(from.y)}`,
        `C ${round(from.x)} ${round(from.y + offset * direction)},`,
        `${round(to.x)} ${round(to.y - offset * direction)},`,
        `${round(to.x)} ${round(to.y)}`
      ].join(" ");
    }

    const bend = Math.max(48, Math.min(160, Math.abs(dx) * 0.5));
    const direction = dx >= 0 ? 1 : -1;
    return [
      `M ${round(from.x)} ${round(from.y)}`,
      `C ${round(from.x + bend * direction)} ${round(from.y)},`,
      `${round(to.x - bend * direction)} ${round(to.y)},`,
      `${round(to.x)} ${round(to.y)}`
    ].join(" ");
  }

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  function analyzeCircuit() {
    const shortedBatteries = findShortedBatteries();

    return {
      poweredBulbs: computePoweredBulbs(shortedBatteries),
      hasShortCircuit: shortedBatteries.size > 0
    };
  }

  function findShortedBatteries() {
    const shorted = new Set();
    const adjacency = buildConductiveGraph({ includeBulbs: false });

    state.components
      .filter((component) => component.type === "battery")
      .forEach((battery) => {
        const batteryNeg = terminalNode(battery.id, "neg");
        const batteryPos = terminalNode(battery.id, "pos");

        if (areConnected(adjacency, batteryNeg, batteryPos)) {
          shorted.add(battery.id);
        }
      });

    return shorted;
  }

  function computePoweredBulbs(shortedBatteries) {
    const powered = new Set();
    const batteries = state.components.filter((component) => component.type === "battery");
    const bulbs = state.components.filter((component) => component.type === "bulb");

    bulbs.forEach((bulb) => {
      const bulbA = terminalNode(bulb.id, "a");
      const bulbB = terminalNode(bulb.id, "b");

      const isPowered = batteries.some((battery) => {
        if (shortedBatteries.has(battery.id)) {
          return false;
        }

        const batteryNeg = terminalNode(battery.id, "neg");
        const batteryPos = terminalNode(battery.id, "pos");
        const adjacency = buildConductiveGraph({ ignoredBulbId: bulb.id });

        const normalPath =
          areConnected(adjacency, bulbA, batteryNeg) &&
          areConnected(adjacency, bulbB, batteryPos);
        const reversePath =
          areConnected(adjacency, bulbA, batteryPos) &&
          areConnected(adjacency, bulbB, batteryNeg);

        return normalPath || reversePath;
      });

      if (isPowered) {
        powered.add(bulb.id);
      }
    });

    return powered;
  }

  function buildConductiveGraph(options = {}) {
    const ignoredBulbId = options.ignoredBulbId;
    const includeBulbs = options.includeBulbs !== false;
    const adjacency = new Map();

    state.components.forEach((component) => {
      COMPONENT_SPECS[component.type].terminals.forEach((terminal) => {
        ensureNode(adjacency, terminalNode(component.id, terminal.id));
      });
    });

    state.wires.forEach((wire) => {
      if (!getComponent(wire.fromComponentId) || !getComponent(wire.toComponentId)) {
        return;
      }
      addGraphEdge(
        adjacency,
        terminalNode(wire.fromComponentId, wire.fromTerminalId),
        terminalNode(wire.toComponentId, wire.toTerminalId)
      );
    });

    state.components.forEach((component) => {
      if (component.type === "switch" && component.isClosed) {
        addGraphEdge(
          adjacency,
          terminalNode(component.id, "a"),
          terminalNode(component.id, "b")
        );
      }

      if (
        includeBulbs &&
        component.type === "bulb" &&
        component.id !== ignoredBulbId
      ) {
        addGraphEdge(
          adjacency,
          terminalNode(component.id, "a"),
          terminalNode(component.id, "b")
        );
      }
    });

    return adjacency;
  }

  function ensureNode(adjacency, node) {
    if (!adjacency.has(node)) {
      adjacency.set(node, new Set());
    }
  }

  function addGraphEdge(adjacency, from, to) {
    ensureNode(adjacency, from);
    ensureNode(adjacency, to);
    adjacency.get(from).add(to);
    adjacency.get(to).add(from);
  }

  function areConnected(adjacency, start, target) {
    if (start === target) {
      return true;
    }

    const queue = [start];
    const visited = new Set(queue);

    while (queue.length) {
      const current = queue.shift();
      const neighbors = adjacency.get(current);
      if (!neighbors) {
        continue;
      }

      for (const next of neighbors) {
        if (next === target) {
          return true;
        }
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    return false;
  }

  function terminalNode(componentId, terminalId) {
    return `${componentId}:${terminalId}`;
  }

  function getComponent(componentId) {
    return state.components.find((component) => component.id === componentId);
  }

  function getTerminalPosition(componentId, terminalId) {
    const component = getComponent(componentId);
    if (!component) {
      return null;
    }

    const terminal = COMPONENT_SPECS[component.type].terminals.find(
      (item) => item.id === terminalId
    );
    if (!terminal) {
      return null;
    }

    return {
      x: component.x + terminal.x,
      y: component.y + terminal.y
    };
  }

  function getTerminalUnderPointer(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    const terminal = element ? element.closest(".terminal") : null;
    if (!terminal || !elements.board.contains(terminal)) {
      return null;
    }

    return {
      componentId: terminal.dataset.componentId,
      terminalId: terminal.dataset.terminalId
    };
  }

  function clientToBoard(clientX, clientY) {
    const rect = elements.board.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  function isInsideBoard(clientX, clientY) {
    const rect = elements.board.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  function clampComponentPosition(type, x, y) {
    const spec = COMPONENT_SPECS[type];
    const rect = elements.board.getBoundingClientRect();
    const padding = 8;
    return {
      x: clamp(x, padding, Math.max(padding, rect.width - spec.width - padding)),
      y: clamp(y, padding, Math.max(padding, rect.height - spec.height - padding))
    };
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function updateStatus() {
    const componentCount = state.components.length;
    const cableCount = state.wires.length;
    const poweredCount = state.poweredBulbs.size;

    elements.canvasSummary.textContent = `${componentCount} ${plural(
      componentCount,
      "component"
    )}, ${cableCount} ${plural(cableCount, "cable")}`;

    elements.powerStatus.classList.toggle(
      "is-powered",
      poweredCount > 0 && !state.hasShortCircuit
    );
    elements.powerStatus.classList.toggle("is-short", state.hasShortCircuit);
    if (componentCount === 0) {
      elements.powerStatus.textContent = "Canvas ready";
    } else if (state.hasShortCircuit) {
      elements.powerStatus.textContent = "Short circuit";
    } else if (poweredCount > 0) {
      elements.powerStatus.textContent = `${poweredCount} ${plural(
        poweredCount,
        "bulb"
      )} on`;
    } else {
      elements.powerStatus.textContent = "Circuit unpowered";
    }

    elements.selectionStatus.textContent = describeSelection();
    elements.deleteBtn.disabled = !state.selected;
  }

  function describeSelection() {
    if (!state.selected) {
      return "Nothing selected";
    }

    if (state.selected.type === "wire") {
      return "Cable selected";
    }

    const component = getComponent(state.selected.id);
    if (!component) {
      state.selected = null;
      return "Nothing selected";
    }

    return `${COMPONENT_SPECS[component.type].label} selected`;
  }

  function plural(count, word) {
    return count === 1 ? word : `${word}s`;
  }
})();
