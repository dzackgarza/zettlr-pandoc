# Coble lattices and rational surfaces

Blowing up the projective plane in the nine base points of a Halphen pencil
produces a rational elliptic surface; a tenth infinitely near blowup yields a
Coble surface whose numerical invariants are governed by the lattices below.

## Moduli of marked surfaces {#sec:moduli}

The period map identifies the moduli space of marked surfaces with an
arithmetic quotient of a bounded symmetric domain of type IV, and the
lattice-theoretic data of the marking determines the boundary components.

| Lattice              | Signature | Discriminant group     |
|----------------------|-----------|------------------------|
| $U$                  | $(1,1)$   | trivial                |
| $E_{10}$             | $(1,9)$   | trivial                |
| $U \oplus E_8(2)$    | $(1,9)$   | $(\mathbb{Z}/2)^{8}$   |

: Coble lattices of Halphen type {#tbl:coble-lattices}

Every effective class pairs with the half-fiber through the quadratic form

$$ q(x) = x^2 $$ {#eq:intersection-form}

so isotropic classes correspond exactly to the elliptic fibrations of the
surface, one for each primitive isotropic vector up to the Weyl group.

![Root diagram](roots.png){#fig:root-diagram}

```{#lst:sage-run .python caption="Sage session"}
L = IntegralLattice("U").direct_sum(IntegralLattice("E8").twist(2))
L.signature_pair()
```
