use pdm_core::{CoreError, Role};

#[test]
fn round_trips_through_string() {
    for r in [Role::Admin, Role::Editor, Role::Viewer] {
        let s = r.to_string();
        let parsed: Role = s.parse().unwrap();
        assert_eq!(parsed, r);
    }
}

#[test]
fn lowercase_strings_match_postgres_check_constraint() {
    assert_eq!(Role::Admin.to_string(), "admin");
    assert_eq!(Role::Editor.to_string(), "editor");
    assert_eq!(Role::Viewer.to_string(), "viewer");
}

#[test]
fn unknown_role_rejected() {
    let err = "owner".parse::<Role>().unwrap_err();
    assert!(matches!(err, CoreError::InvalidRole(_)));
}

#[test]
fn admin_implies_editor_capabilities() {
    assert!(Role::Admin.can_check_in_out());
    assert!(Role::Editor.can_check_in_out());
    assert!(!Role::Viewer.can_check_in_out());

    assert!(Role::Admin.is_admin());
    assert!(!Role::Editor.is_admin());
    assert!(!Role::Viewer.is_admin());
}
