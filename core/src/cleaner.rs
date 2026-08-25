/// Conservative first-pass cleanup. This intentionally removes only standalone,
/// high-confidence fillers; semantic rewriting belongs to a separate stage.
pub fn deterministic_clean(input: &str) -> String {
    const FILLERS: &[&str] = &["えー", "えーと", "えっと", "あー", "あのー", "そのー", "うーん"];
    let mut out = input.to_owned();
    for filler in FILLERS {
        out = out.replace(&format!("{}、", filler), "");
        out = out.replace(&format!("{} ", filler), "");
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removes_common_filler_but_preserves_semantic_sono() {
        let input = "えっと、 その人について考えたい";
        assert_eq!(deterministic_clean(input), "その人について考えたい");
    }
}
