// The administration web app is how we do Trezor integration, outsourcing
// transaction signing to MetaMask

import { Administration, TokenFront } from "../src";

import { VNode, createProjector, h } from "maquette";
import * as Web3 from "web3";

// Possible operations
export enum Operation {
  AbortCall,
  SetResolver,
  Clawback,
  Migrate,
  NewAdmin,
  NewLogic,
  Rotate,
  Bind
}

interface AppEvent extends Event {
  payload: AppL;
}

export const randomKey = () => Math.random().toString();

// ~~~~~~~~~~~~~~~~~~ //
// Interface elements //
// ~~~~~~~~~~~~~~~~~~ //

export const header = (text: string): VNode => h("h1", {}, [text]);

export const section = (text: string, nodes: VNode[]) =>
  h("section", { key: text }, [h("p", {}, [text])].concat(nodes));

export const button = (text: string, onClick: () => void): VNode =>
  h("span", { class: "button", key: text, onclick: onClick }, [text]);

export const userInput = (
  inputs: string[],
  emit: (prog: AppL) => void,
  handler: (vals: string[]) => AppL
): VNode => {
  const nodes = inputs.map((name, i) => {
    const input = h(
      "input",
      {
        oninput: e => {
          emit(newFieldState(name, (e.target as any).value));
        }
      },
      []
    );

    return h("div", { key: name }, [h("p", {}, [name]), input]);
  });

  const f = (names: string[], vals: string[]): AppL => {
    if (names.length === 0) {
      return handler(vals);
    }
    const n = names.shift() as string;
    return withInput(n, v => {
      vals.unshift(v);
      return f(names, vals);
    });
  };

  nodes.push(button("go!", () => emit(f(inputs, []))));

  return h("div", { key: inputs.join("|") }, nodes);
};

// Application

export type CallData =
  | {
      method: "Clawback";
      callNumber: number;
      src: string;
      dst: string;
      amount: number;
    }
  | { method: "Bind"; callNumber: number; logic: string; front: string };

export type CallHandler = (address: string, callData: CallData) => void;

export type Admin = {
  bind: (tokenLogic: string, tokenFront: string) => void;
  clawback: (src: string, dst: string, amount: number) => void;
};

export type AppNode =
  | "start"
  | "operations"
  | "operation"
  | "summary"
  | "error";

export type AppState = {
  node: AppNode;
  adminAddress: string | null;
  operation: Operation | null;
  lastCall: CallData | null;
  lastError: Error | null;
  fieldStates: Map<string, string>;
};

export type AppL =
  | { tag: "block"; xs: AppL[] }
  | { tag: "execute"; call: CallData }
  | { tag: "nav"; node: AppNode }
  | { tag: "selectOperation"; operation: Operation }
  | { tag: "newFieldState"; location: string; value: string }
  | { tag: "withAdminContext"; address: string; next: AppL }
  | { tag: "withFreshCallNumber"; handler: (n: number) => AppL }
  | { tag: "withInput"; location: string; handler: (value: string) => AppL }
  | {
      tag: "withTokenLogic";
      address: string;
      handler: (logic: string) => AppL;
    };

export const block = (xs: AppL[]): AppL => ({ tag: "block", xs });

export const nav = (node: AppNode): AppL => ({ tag: "nav", node });

export const selectOperation = (operation: Operation): AppL => ({
  tag: "selectOperation",
  operation
});

export const newFieldState = (location: string, value: string): AppL => ({
  tag: "newFieldState",
  location,
  value
});

export const withAdminContext = (address: string, next: AppL): AppL => ({
  tag: "withAdminContext",
  address,
  next
});

export const withFreshCallNumber = (handler: (n: number) => AppL): AppL => ({
  tag: "withFreshCallNumber",
  handler
});

export const withInput = (
  location: string,
  handler: (v: string) => AppL
): AppL => ({
  tag: "withInput",
  location,
  handler
});

export const withTokenLogic = (
  address: string,
  handler: (logic: string) => AppL
): AppL => ({
  tag: "withTokenLogic",
  address,
  handler
});

export const executeCall = (call: CallData): AppL => ({ tag: "execute", call });

export type Evaluator<A> = (prog: AppL) => A;

export const render = (state: AppState, send: (prog: AppL) => void): VNode => {
  const start = h("div", {}, [
    header("welcome to S3 administration"),
    section("initiate operation", [
      userInput(["administration address"], send, ([address]) =>
        withAdminContext(address, nav("operations"))
      )
    ]),
    section("cosign operation", [
      userInput(["operation blob"], send, ([callBlob]) =>
        executeCall(JSON.parse(callBlob))
      )
    ])
  ]);

  switch (state.node) {
    case "start":
      return start;

    case "operations":
      const select = (name: string, op: Operation) =>
        button(name, () => send(selectOperation(op)));
      return h("div", {}, [
        header("operations:"),
        select("Bind", Operation.Bind),
        select("Clawback", Operation.Clawback)
      ]);

    case "operation":
      switch (state.operation) {
        case Operation.Bind:
          return h("div", {}, [
            header("please enter the token address"),
            userInput(["token address"], send, ([address]) =>
              withTokenLogic(address, logic =>
                block([
                  withFreshCallNumber(callNumber =>
                    executeCall({
                      method: "Bind",
                      callNumber,
                      logic,
                      front: address
                    })
                  ),
                  nav("summary")
                ])
              )
            )
          ]);

        case Operation.Clawback:
          return h("div", {}, [
            header("please enter the following"),
            userInput(
              ["source", "destination", "amount"],
              send,
              ([src, dst, amount]) =>
                block([
                  withFreshCallNumber(callNumber =>
                    executeCall({
                      method: "Clawback",
                      callNumber,
                      src,
                      dst,
                      amount: parseInt(amount)
                    })
                  ),
                  nav("summary")
                ])
            )
          ]);

        default:
          return start;
      }

    case "summary":
      return h("div", {}, [
        header("Call summary"),
        state.lastCall === null
          ? "no call to display"
          : h("pre", {}, [JSON.stringify(state.lastCall, undefined, 2)])
      ]);

    case "error":
      return h("div", {}, [
        header("there was a problem"),
        state.lastError === null
          ? h("pre", { class: "error" }, ["we cannot find the error"])
          : h("pre", { class: "error" }, [state.lastError.message])
      ]);
  }
};

export const run = () => {
  console.log("starting app..");

  (window as any).ethereum.enable();
  const web3 = new Web3((window as any).ethereum);

  const state: AppState = {
    node: "start",
    adminAddress: null,
    operation: null,
    lastCall: null,
    lastError: null,
    fieldStates: new Map()
  };

  const withAdmin = <T>(cb: (admin: any) => T): T | null => {
    if (state.adminAddress !== null) {
      console.log("instantiating the admin");

      const admin = web3.eth
        .contract(Administration.abi)
        .at(state.adminAddress);

      return cb(admin);
    }
    return null;
  };

  const evaluate = (x: AppL) => {
    console.log(x.tag);

    switch (x.tag) {
      case "block":
        x.xs.forEach(evaluate);
        break;

      case "execute":
        state.lastCall = x.call;
        withAdmin(admin => {
          const c = x.call;
          switch (c.method) {
            case "Bind":
              admin.bind(c.callNumber, c.logic, c.front, { gas: 3e5 });
              break;
            case "Clawback":
              admin.clawback(c.callNumber, c.src, c.dst, c.amount, {
                gas: 3e5
              });
              break;
          }
        });
        break;

      case "nav":
        state.node = x.node;
        break;

      case "newFieldState":
        state.fieldStates.set(x.location, x.value);
        break;

      case "selectOperation":
        state.node = "operation";
        state.operation = x.operation;
        break;

      case "withAdminContext":
        state.adminAddress = x.address;
        evaluate(x.next);
        break;

      case "withFreshCallNumber":
        withAdmin(admin =>
          evaluate(x.handler(admin.maximumClaimedCallNumber.call() + 1))
        );
        break;

      case "withInput":
        evaluate(
          x.handler(
            state.fieldStates.has(x.location)
              ? state.fieldStates.get(x.location)!
              : ""
          )
        );
        break;

      case "withTokenLogic":
        const tf = web3.eth.contract(TokenFront.abi).at(x.address);
        evaluate(x.handler(tf.tokenLogic.call()));
        break;
    }
  };

  document.addEventListener("app-event", (e: AppEvent) => {
    try {
      evaluate(e.payload);
    } catch (err) {
      state.node = "error";
      state.lastError = err;
    }

    console.log(state);
  });

  const main = document.getElementById("main");

  if (main !== null) {
    const proj = createProjector();
    proj.replace(main, () =>
      render(state, x => {
        const ev = new Event("app-event") as AppEvent;
        ev.payload = x;
        document.dispatchEvent(ev);
      })
    );
  }
};

run();
