(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const TERMINAL_RADIUS = 13;
  const SHORT_CIRCUIT_FIRE_DELAY_MS = 10000;
  const SHORT_TIMER_TICK_MS = 120;
  const COMPONENT_SPECS = {
    battery: {
      label: "Battery",
      width: 132,
      height: 88,
      terminals: [
        { id: "neg", label: "-", x: -2, y: 44 },
        { id: "pos", label: "+", x: 134, y: 44 }
      ]
    },
    bulb: {
      label: "Light bulb",
      width: 118,
      height: 124,
      terminals: [
        { id: "a", label: "", x: 34, y: 126 },
        { id: "b", label: "", x: 84, y: 126 }
      ]
    },
    switch: {
      label: "Switch",
      width: 132,
      height: 82,
      terminals: [
        { id: "a", label: "", x: -2, y: 44 },
        { id: "b", label: "", x: 134, y: 44 }
      ]
    }
  };

  const state = {
    components: [],
    wires: [],
    selected: null,
    poweredBulbs: new Set(),
    poweredWires: new Set(),
    shortedWires: new Set(),
    shortedBatteryIds: new Set(),
    batteryShorts: new Map(),
    hasShortCircuit: false,
    hasBatteryFire: false
  };

  const elements = {};
  let nextId = 1;
  let interaction = null;
  let shortTimerId = null;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    elements.board = document.getElementById("board");
    elements.wireLayer = document.getElementById("wireLayer");
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

  function startWireBend(event, wireId) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    state.selected = { type: "wire", id: wireId };

    const point = clientToBoard(event.clientX, event.clientY);
    interaction = {
      mode: "wire-bend",
      pointerId: event.pointerId,
      wireId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPoint: point,
      moved: false
    };

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
      return;
    }

    if (interaction.mode === "wire-bend") {
      const wire = getWire(interaction.wireId);
      if (!wire) {
        cancelInteraction();
        return;
      }

      const distance = Math.hypot(
        event.clientX - interaction.startClientX,
        event.clientY - interaction.startClientY
      );
      interaction.moved = interaction.moved || distance > 4;

      if (interaction.moved) {
        wire.control = clampBoardPoint(clientToBoard(event.clientX, event.clientY));
        render();
      }
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
      return;
    }

    if (interaction.mode === "wire-bend") {
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
      toTerminalId: target.terminalId,
      control: null
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
    state.poweredWires = new Set();
    state.shortedWires = new Set();
    state.shortedBatteryIds = new Set();
    state.batteryShorts.clear();
    state.hasShortCircuit = false;
    state.hasBatteryFire = false;
    syncShortTimerLoop();
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
    const now = performance.now();
    syncBatteryShorts(analysis.shortedBatteryIds, now);
    state.poweredBulbs = analysis.poweredBulbs;
    state.poweredWires = analysis.poweredWires;
    state.shortedWires = analysis.shortedWires;
    state.shortedBatteryIds = analysis.shortedBatteryIds;
    state.hasShortCircuit = analysis.hasShortCircuit;
    state.hasBatteryFire = hasActiveBatteryFire(now);
    renderWires();
    renderComponents(now);
    updateStatus();
    syncShortTimerLoop();
  }

  function syncWireLayerSize() {
    const rect = elements.board.getBoundingClientRect();
    elements.wireLayer.setAttribute("width", rect.width);
    elements.wireLayer.setAttribute("height", rect.height);
    elements.wireLayer.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  }

  function renderWires() {
    elements.wireLayer.innerHTML = "";

    state.wires.forEach((wire) => {
      const from = getTerminalPosition(wire.fromComponentId, wire.fromTerminalId);
      const to = getTerminalPosition(wire.toComponentId, wire.toTerminalId);
      if (!from || !to) {
        return;
      }

      const control = getWireControlPoint(wire, from, to);
      const pathData = cablePath(from, to, control);
      const sleeve = makePath(pathData, "wire-sleeve");
      const visible = makePath(pathData, "wire-visible");
      const hit = makePath(pathData, "wire-hit");
      const isSelected =
        state.selected &&
        state.selected.type === "wire" &&
        state.selected.id === wire.id;
      const isPowered = state.poweredWires.has(wire.id);
      const isShorted = state.shortedWires.has(wire.id);

      if (isSelected) {
        sleeve.classList.add("is-selected");
        visible.classList.add("is-selected");
      }
      if (isShorted) {
        sleeve.classList.add("is-short");
        visible.classList.add("is-short");
      } else if (isPowered) {
        sleeve.classList.add("is-powered");
        visible.classList.add("is-powered");
      }

      hit.dataset.wireId = wire.id;
      hit.addEventListener("pointerdown", (event) => startWireBend(event, wire.id));

      elements.wireLayer.appendChild(sleeve);
      elements.wireLayer.appendChild(visible);
      elements.wireLayer.appendChild(hit);

      if (isSelected) {
        elements.wireLayer.appendChild(makeWireControl(control));
      }
    });

    if (interaction && interaction.mode === "wire") {
      const from = getTerminalPosition(
        interaction.fromComponentId,
        interaction.fromTerminalId
      );
      if (from && interaction.end) {
        elements.wireLayer.appendChild(
          makePath(
            cablePath(from, interaction.end, getDefaultCableControl(from, interaction.end)),
            "wire-preview"
          )
        );
      }
    }
  }

  function renderComponents(now = performance.now()) {
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
      const shortState =
        component.type === "battery" ? getBatteryShortState(component.id, now) : null;

      element.className = [
        "component",
        `component-${component.type}`,
        component.isClosed ? "is-closed" : "",
        isSelected ? "is-selected" : "",
        isPowered ? "is-powered" : "",
        shortState ? "is-short" : "",
        shortState && shortState.isBurning ? "is-burning" : ""
      ]
        .filter(Boolean)
        .join(" ");

      element.dataset.componentId = component.id;
      element.style.left = `${component.x}px`;
      element.style.top = `${component.y}px`;
      element.style.setProperty("--component-width", `${spec.width}px`);
      element.style.setProperty("--component-height", `${spec.height}px`);
      if (shortState) {
        applyBatteryHeatStyles(element, shortState.progress);
      }
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
        terminalElement.style.left = `${terminal.x - TERMINAL_RADIUS}px`;
        terminalElement.style.top = `${terminal.y - TERMINAL_RADIUS}px`;
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
        <div class="battery-fire" aria-hidden="true">
          <span class="flame flame-a"></span>
          <span class="flame flame-b"></span>
          <span class="flame flame-c"></span>
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

  function makeWireControl(point) {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", point.x);
    circle.setAttribute("cy", point.y);
    circle.setAttribute("r", 6);
    circle.setAttribute("class", "wire-control");
    return circle;
  }

  function cablePath(from, to, control) {
    return [
      `M ${round(from.x)} ${round(from.y)}`,
      `Q ${round(control.x)} ${round(control.y)},`,
      `${round(to.x)} ${round(to.y)}`
    ].join(" ");
  }

  function getWireControlPoint(wire, from, to) {
    if (wire.control) {
      return wire.control;
    }

    return getDefaultCableControl(from, to);
  }

  function getDefaultCableControl(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    const sag = Math.max(20, Math.min(86, distance * 0.18));
    const bendDirection = dy >= 0 ? 1 : -1;

    return {
      x: from.x + dx / 2,
      y: from.y + dy / 2 + sag * bendDirection
    };
  }

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  function analyzeCircuit() {
    const shortedBatteries = findShortedBatteries();
    const powerAnalysis = computePowerAnalysis(shortedBatteries);
    const shortedWires = new Set();
    const shortedBatteryIds = new Set(shortedBatteries.keys());

    shortedBatteries.forEach((pathWireIds) => {
      pathWireIds.forEach((wireId) => shortedWires.add(wireId));
    });

    return {
      poweredBulbs: powerAnalysis.poweredBulbs,
      poweredWires: powerAnalysis.poweredWires,
      shortedWires,
      shortedBatteryIds,
      hasShortCircuit: shortedBatteries.size > 0
    };
  }

  function syncBatteryShorts(shortedBatteryIds, now) {
    state.batteryShorts.forEach((record, batteryId) => {
      if (!shortedBatteryIds.has(batteryId)) {
        state.batteryShorts.delete(batteryId);
      }
    });

    shortedBatteryIds.forEach((batteryId) => {
      if (!state.batteryShorts.has(batteryId)) {
        state.batteryShorts.set(batteryId, { startedAt: now });
      }
    });
  }

  function syncShortTimerLoop() {
    const needsTimer = state.batteryShorts.size > 0;
    if (needsTimer && shortTimerId === null) {
      shortTimerId = window.setInterval(render, SHORT_TIMER_TICK_MS);
      return;
    }

    if (!needsTimer && shortTimerId !== null) {
      window.clearInterval(shortTimerId);
      shortTimerId = null;
    }
  }

  function getBatteryShortState(batteryId, now) {
    const record = state.batteryShorts.get(batteryId);
    if (!record) {
      return null;
    }

    const progress = clamp(
      (now - record.startedAt) / SHORT_CIRCUIT_FIRE_DELAY_MS,
      0,
      1
    );

    return {
      progress,
      isBurning: progress >= 1
    };
  }

  function hasActiveBatteryFire(now) {
    return Array.from(state.batteryShorts.keys()).some((batteryId) => {
      const shortState = getBatteryShortState(batteryId, now);
      return shortState && shortState.isBurning;
    });
  }

  function applyBatteryHeatStyles(element, progress) {
    element.style.setProperty("--battery-case-color", mixColor("#ffffff", "#f24a2f", progress));
    element.style.setProperty("--battery-cell-color", mixColor("#28724a", "#ea3221", progress));
    element.style.setProperty("--battery-tall-cell-color", mixColor("#d9643a", "#ff1f12", progress));
    element.style.setProperty("--battery-heat-alpha", (progress * 0.46).toFixed(3));
    element.style.setProperty("--battery-glow-alpha", (progress * 0.54).toFixed(3));
  }

  function mixColor(fromHex, toHex, amount) {
    const from = hexToRgb(fromHex);
    const to = hexToRgb(toHex);
    const mix = (start, end) => Math.round(start + (end - start) * amount);
    return `rgb(${mix(from.r, to.r)}, ${mix(from.g, to.g)}, ${mix(from.b, to.b)})`;
  }

  function hexToRgb(hex) {
    const value = hex.replace("#", "");
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16)
    };
  }

  function findShortedBatteries() {
    const shorted = new Map();
    const batteryCount = state.components.filter(
      (component) => component.type === "battery"
    ).length;

    state.components
      .filter((component) => component.type === "battery")
      .forEach((battery) => {
        const adjacency = buildConductiveGraph({
          includeBulbs: false,
          conductiveBatteryId: battery.id,
          trackBatteryVoltage: true
        });
        const batteryNeg = terminalNode(battery.id, "neg");
        const batteryPos = terminalNode(battery.id, "pos");
        const shortPathWireIds = findUnsafeBatteryShortPath(
          adjacency,
          batteryNeg,
          batteryPos,
          1,
          batteryCount + 1
        );

        if (shortPathWireIds) {
          shorted.set(battery.id, shortPathWireIds);
        }
      });

    return shorted;
  }

  function computePowerAnalysis(shortedBatteries) {
    const poweredBulbs = new Set();
    const poweredWires = new Set();
    const batteries = state.components.filter((component) => component.type === "battery");
    const bulbs = state.components.filter((component) => component.type === "bulb");
    const activeBatteryIds = new Set(
      batteries
        .filter((battery) => !shortedBatteries.has(battery.id))
        .map((battery) => battery.id)
    );

    bulbs.forEach((bulb) => {
      const bulbA = terminalNode(bulb.id, "a");
      const bulbB = terminalNode(bulb.id, "b");
      const adjacency = buildConductiveGraph({
        ignoredBulbId: bulb.id,
        conductiveBatteryIds: activeBatteryIds,
        trackBatteryVoltage: true
      });
      const voltageAnalysis = computeVoltageAnalysis(adjacency);
      const terminalA = voltageAnalysis.nodes.get(bulbA);
      const terminalB = voltageAnalysis.nodes.get(bulbB);

      if (
        terminalA &&
        terminalB &&
        terminalA.networkId === terminalB.networkId &&
        !voltageAnalysis.inconsistentNetworks.has(terminalA.networkId) &&
        terminalA.voltage !== terminalB.voltage
      ) {
        poweredBulbs.add(bulb.id);
        const circuitPath = findPathWireIds(adjacency, bulbA, bulbB);
        if (circuitPath) {
          addWireIds(poweredWires, circuitPath);
        }
      }
    });

    return { poweredBulbs, poweredWires };
  }

  function addWireIds(target, wireIds) {
    wireIds.forEach((wireId) => target.add(wireId));
  }

  function buildConductiveGraph(options = {}) {
    const ignoredBulbId = options.ignoredBulbId;
    const includeBulbs = options.includeBulbs !== false;
    const conductiveBatteryId = options.conductiveBatteryId;
    const conductiveBatteryIds = options.conductiveBatteryIds;
    const trackBatteryVoltage = Boolean(options.trackBatteryVoltage);
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
        terminalNode(wire.toComponentId, wire.toTerminalId),
        wire.id
      );
    });

    state.components.forEach((component) => {
      if (component.type === "switch" && component.isClosed) {
        addGraphEdge(
          adjacency,
          terminalNode(component.id, "a"),
          terminalNode(component.id, "b"),
          null
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
          terminalNode(component.id, "b"),
          null
        );
      }

      if (
        component.type === "battery" &&
        shouldConductBattery(component.id, conductiveBatteryId, conductiveBatteryIds)
      ) {
        addGraphEdge(
          adjacency,
          terminalNode(component.id, "neg"),
          terminalNode(component.id, "pos"),
          null,
          trackBatteryVoltage ? 1 : 0
        );
      }
    });

    return adjacency;
  }

  function shouldConductBattery(componentId, conductiveBatteryId, conductiveBatteryIds) {
    if (conductiveBatteryIds) {
      return conductiveBatteryIds.has(componentId);
    }

    return Boolean(conductiveBatteryId && componentId !== conductiveBatteryId);
  }

  function ensureNode(adjacency, node) {
    if (!adjacency.has(node)) {
      adjacency.set(node, []);
    }
  }

  function addGraphEdge(adjacency, from, to, wireId, voltageDelta = 0) {
    ensureNode(adjacency, from);
    ensureNode(adjacency, to);
    adjacency.get(from).push({ to, wireId, voltageDelta });
    adjacency.get(to).push({ to: from, wireId, voltageDelta: -voltageDelta });
  }

  function areConnected(adjacency, start, target) {
    return Boolean(findPathWireIds(adjacency, start, target));
  }

  function findPathWireIds(adjacency, start, target) {
    if (start === target) {
      return new Set();
    }

    const queue = [start];
    const visited = new Set(queue);
    const previous = new Map();

    while (queue.length) {
      const current = queue.shift();
      const neighbors = adjacency.get(current);
      if (!neighbors) {
        continue;
      }

      for (const edge of neighbors) {
        const next = edge.to;
        if (visited.has(next)) {
          continue;
        }

        visited.add(next);
        previous.set(next, { from: current, wireId: edge.wireId });

        if (next === target) {
          return collectPathWireIds(previous, start, target);
        }

        queue.push(next);
      }
    }

    return null;
  }

  function computeVoltageAnalysis(adjacency) {
    const nodes = new Map();
    const inconsistentNetworks = new Set();
    let nextNetworkId = 1;

    adjacency.forEach((_, start) => {
      if (nodes.has(start)) {
        return;
      }

      const networkId = nextNetworkId;
      nextNetworkId += 1;
      nodes.set(start, { networkId, voltage: 0 });
      const queue = [start];

      while (queue.length) {
        const current = queue.shift();
        const currentState = nodes.get(current);
        const neighbors = adjacency.get(current);
        if (!neighbors) {
          continue;
        }

        for (const edge of neighbors) {
          const nextVoltage = currentState.voltage + (edge.voltageDelta || 0);
          const nextState = nodes.get(edge.to);

          if (!nextState) {
            nodes.set(edge.to, { networkId, voltage: nextVoltage });
            queue.push(edge.to);
            continue;
          }

          if (
            nextState.networkId === networkId &&
            nextState.voltage !== nextVoltage
          ) {
            inconsistentNetworks.add(networkId);
          }
        }
      }
    });

    return { nodes, inconsistentNetworks };
  }

  function findUnsafeBatteryShortPath(
    adjacency,
    start,
    target,
    expectedVoltageDelta,
    maxAbsVoltageDelta
  ) {
    if (start === target) {
      return null;
    }

    const startState = pathStateKey(start, 0);
    const queue = [{ node: start, voltageDelta: 0, key: startState }];
    const visited = new Set([startState]);
    const previous = new Map();

    while (queue.length) {
      const current = queue.shift();
      const neighbors = adjacency.get(current.node);
      if (!neighbors) {
        continue;
      }

      for (const edge of neighbors) {
        const nextVoltageDelta = current.voltageDelta + (edge.voltageDelta || 0);
        if (Math.abs(nextVoltageDelta) > maxAbsVoltageDelta) {
          continue;
        }

        const next = edge.to;
        const nextKey = pathStateKey(next, nextVoltageDelta);
        if (visited.has(nextKey)) {
          continue;
        }

        visited.add(nextKey);
        previous.set(nextKey, { fromKey: current.key, wireId: edge.wireId });

        if (next === target && nextVoltageDelta !== expectedVoltageDelta) {
          return collectStatePathWireIds(previous, startState, nextKey);
        }

        queue.push({ node: next, voltageDelta: nextVoltageDelta, key: nextKey });
      }
    }

    return null;
  }

  function collectPathWireIds(previous, start, target) {
    const wireIds = new Set();
    let current = target;

    while (current !== start) {
      const step = previous.get(current);
      if (!step) {
        return null;
      }

      if (step.wireId) {
        wireIds.add(step.wireId);
      }

      current = step.from;
    }

    return wireIds;
  }

  function collectStatePathWireIds(previous, startKey, targetKey) {
    const wireIds = new Set();
    let currentKey = targetKey;

    while (currentKey !== startKey) {
      const step = previous.get(currentKey);
      if (!step) {
        return null;
      }

      if (step.wireId) {
        wireIds.add(step.wireId);
      }

      currentKey = step.fromKey;
    }

    return wireIds;
  }

  function pathStateKey(node, voltageDelta) {
    return `${node}|${voltageDelta}`;
  }

  function terminalNode(componentId, terminalId) {
    return `${componentId}:${terminalId}`;
  }

  function getComponent(componentId) {
    return state.components.find((component) => component.id === componentId);
  }

  function getWire(wireId) {
    return state.wires.find((wire) => wire.id === wireId);
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

  function clampBoardPoint(point) {
    const rect = elements.board.getBoundingClientRect();
    const padding = TERMINAL_RADIUS;
    return {
      x: clamp(point.x, padding, Math.max(padding, rect.width - padding)),
      y: clamp(point.y, padding, Math.max(padding, rect.height - padding))
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
    const padding = 24;
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
    elements.powerStatus.classList.toggle("is-fire", state.hasBatteryFire);
    if (componentCount === 0) {
      elements.powerStatus.textContent = "Canvas ready";
    } else if (state.hasBatteryFire) {
      elements.powerStatus.textContent = "Battery fire";
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
