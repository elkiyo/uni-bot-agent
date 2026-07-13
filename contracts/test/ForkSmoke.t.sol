// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

interface IUniswapV3PoolMinimal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
}

contract ForkSmokeTest is Test {
    address constant POOL = 0x6F42B9D2085a0dEb711C00A460a98B9863ae4897;
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant WETH = 0xD221812de1BD094f35587EE8E174B07B6167D9Af;

    function test_forkReadsRealPoolState() public {
        vm.createSelectFork(vm.envString("CELO_RPC_URL"));

        IUniswapV3PoolMinimal pool = IUniswapV3PoolMinimal(POOL);
        assertEq(pool.token0(), USDT, "token0 should be USDT");
        assertEq(pool.token1(), WETH, "token1 should be WETH");
        assertEq(pool.fee(), 3000, "fee tier should be 0.3%");
        assertGt(pool.liquidity(), 0, "pool should have real liquidity");
    }
}
