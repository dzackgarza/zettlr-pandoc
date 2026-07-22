# Subfigure gallery

::: {#fig:coble-panels}
![Left: nodal degeneration](left.png){#fig:coble-left}

![Right: cuspidal degeneration](right.png){#fig:coble-right}

Semistable degenerations of a Coble surface.
:::

## Lattice enumeration {#sec:lattice-enumeration}

::: {#lst:lattice-scan}
Enumerating isotropic vectors in the Coble lattice.

~~~python
for v in L.isotropic_vectors():
    print(v)
~~~
:::

The panels in @fig:coble-panels pair with the enumeration in
@lst:lattice-scan, and the left panel @fig:coble-left shows the generic
degeneration.
