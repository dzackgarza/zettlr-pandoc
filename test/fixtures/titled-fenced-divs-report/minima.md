## Definite minima, minimal shells, and regularity

::: {.definition #def:definite-minimum-shell title="Minimum, minimal vectors, and kissing number"}

Let $L$ be a definite lattice and put $\varepsilon_L=1$ when $L$ is positive definite and $\varepsilon_L=-1$ when $L$ is negative definite.

The **minimum** of $L$ is

$$
\mu(L)
\definedas
\min_{0\neq x\in L}\varepsilon_L x^2
=
\min_{0\neq x\in L}\abs{x^2}
.
$$
The **minimal shell**, or set of **minimal vectors**, is
$$
\operatorname{Min}(L)
\definedas
\theset{x\in L\sm\theset{0}\st \varepsilon_L x^2=\mu(L)}
,
$$
and the **kissing number** of $L$ is
$$
\tau(L)\definedas\abs{\operatorname{Min}(L)}.
$$
Thus both $x$ and $-x$ are counted.
For a negative-definite lattice these are, by convention, the corresponding invariants of $L(-1)$.
:::

::: {.remark title="Standard terminology and the database convention"}

These are the standard Euclidean-lattice notions; see [@CS10, Ch. 1] and [@Mar03].
The lattice database's `definite.minimum`, `definite.minimal_vectors`, and `definite.kissing_number` use exactly this positive-definite normalization.
A stored list of minimal vectors is required to be the complete shell $\operatorname{Min}(L)$, not merely a generating subset.
:::

::: {.definition #def:voronoi-perfect-lattice title="Voronoi-perfect lattices"}

Let $L$ be definite of rank $r$, and identify $L_\QQ$ with $\QQ^r$ after choosing a basis.
The lattice is **perfect in the sense of Voronoi** if
$$
\spanof_\QQ\theset{vv^{\mathsf T}\st v\in\operatorname{Min}(L)}
=
\operatorname{Sym}_r(\QQ)
.
$$
Equivalently, the values of the quadratic form on its minimal vectors determine the form up to scale.
This is the standard notion of a perfect Euclidean lattice [@Mar03, Ch. 4].
:::
