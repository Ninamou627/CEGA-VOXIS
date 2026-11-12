import { describe, expect, it } from "vitest";
import { decodeMicFrame } from "../../shared/framing";
import { MicUplink } from "../../shared/uplink";

/** Une page formateur dont on lit ce qui part sur le socket, trame par trame (D37). */
function page(ring = 600) {
  const sent: number[] = [];
  let t = 1000;
  const up = new MicUplink((f) => sent.push(decodeMicFrame(f).info!.seq), () => (t += 50), ring);
  const say = (n: number) => {
    for (let i = 0; i < n; i++) up.push(new Uint8Array(1600));
  };
  return { up, sent, say };
}

describe("liaison montante du micro (D37)", () => {
  it("rien ne part avant l'admission ; à la première, tout ce qui a été dit pendant la connexion", () => {
    const { up, sent, say } = page();
    say(5); // la page se connecte, le formateur parle déjà
    expect(sent).toEqual([]);
    expect(up.admit(undefined)).toBe(5);
    say(2);
    expect(sent).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("liaison reprise sur le même serveur : seul ce qui lui manque repart, puis le direct", () => {
    const { up, sent, say } = page();
    up.admit(undefined);
    say(4);
    up.detach(); // liaison muette, socket lâché
    say(3); // dit pendant la coupure : gardé, pas envoyé
    expect(sent).toEqual([1, 2, 3, 4]);
    up.admit(2); // le serveur n'avait reçu que 1 et 2
    say(1);
    expect(sent).toEqual([1, 2, 3, 4, 3, 4, 5, 6, 7, 8]);
  });

  it("serveur redémarré : repart ce qui suit la dernière trame qu'il avait confirmée", () => {
    const { up, sent, say } = page();
    up.admit(undefined);
    say(6);
    up.confirm(4); // stats : le serveur avait reçu jusqu'à 4
    up.confirm(99); // un numéro qu'on n'a pas encore produit ne vaut pas confirmation
    up.confirm(null);
    up.detach();
    say(2);
    sent.length = 0;
    up.admit(undefined); // le nouveau serveur ne connaît pas la captation
    expect(sent).toEqual([5, 6, 7, 8]);
  });

  it("garde les 30 dernières secondes, datées à la captation", () => {
    const { up, sent, say } = page(600);
    say(700);
    expect(up.admit(0)).toBe(600);
    expect(sent[0]).toBe(101);
    expect(sent.at(-1)).toBe(700);
    const frames: Uint8Array[] = [];
    const t0 = 5000;
    const dated = new MicUplink((f) => frames.push(f), () => t0);
    dated.admit(undefined);
    dated.push(new Uint8Array([1, 2]));
    expect(decodeMicFrame(frames[0])).toEqual({ pcm: new Uint8Array([1, 2]), info: { seq: 1, tCapture: t0 } });
  });
});
